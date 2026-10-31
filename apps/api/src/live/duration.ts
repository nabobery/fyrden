import type { LiveDurationCompletion, LiveDurationHold, LiveEnvelope } from "./budget.js";

/*
 * Duration a funded operation may keep an object busy, reserved before it
 * is dispatched and charged to the UTC days it can touch: for each day, the
 * most any run starting in the dispatch window (lasting its pending bound
 * and declared tail) can overlap it. The pending bound is the caller's own
 * deadline: a connected call is not cut by the platform at any fixed time
 * (one held 18 minutes on Free completed), so callers must stop waiting at
 * it. A guard is taken before the first await; a finish beyond what was
 * reserved keeps the whole charge.
 */

const DAY = 86_400_000;

/** A pending operation's deadline: the longest it may keep its object waiting. */
export const LIVE_PENDING_MS = 900_000;

export interface LiveDurationGuard {
  readonly grant: LiveEnvelope;
  readonly startedAt: number;
  readonly pendingMs: number;
  readonly tailMs: number;
}

/** How much of `[start, start + length)` falls on `day`. */
const overlap = (start: number, length: number, day: number) =>
  Math.max(0, Math.min(start + length, (day + 1) * DAY) - Math.max(start, day * DAY));

/**
 * The holds covering any run of `pendingMs + tailMs` that starts between
 * `validFrom` and `dispatchUntil`, one a day (two days at most).
 */
export function reserveDuration(
  validFrom: number,
  dispatchUntil: number,
  pendingMs: number,
  tailMs: number,
): readonly LiveDurationHold[] {
  const length = pendingMs + tailMs;
  if (length <= 0 || dispatchUntil < validFrom) throw new RangeError("empty duration");
  const first = Math.floor(validFrom / DAY);
  const last = Math.floor((dispatchUntil + length - 1) / DAY);
  if (last - first > 1) throw new RangeError("duration over more than two days");
  const holds: LiveDurationHold[] = [];
  for (let day = first; day <= last; day++) {
    // The overlap of a window sliding over the dispatch interval peaks at one of these starts.
    const clamp = (s: number) => Math.min(Math.max(s, validFrom), dispatchUntil);
    const ms = Math.max(
      ...[validFrom, dispatchUntil, day * DAY, (day + 1) * DAY - length].map((s) =>
        overlap(clamp(s), length, day),
      ),
    );
    if (ms === 0) continue;
    holds.push({
      day,
      from: Math.max(validFrom, day * DAY),
      until: Math.min(dispatchUntil + length, (day + 1) * DAY),
      ms,
    });
  }
  return holds;
}

/** The grant's hold for `day`, if any. */
const holdOn = (grant: LiveEnvelope, day: number) =>
  grant.plan.charges.find((c) => c.day === day)?.duration ?? null;

/**
 * A guard for a run starting `at`, when the grant is valid then and its
 * holds cover the whole run (its pending bound and tail); null otherwise.
 */
export function beginLiveDuration(
  grant: LiveEnvelope,
  at: number,
  pendingMs: number,
  tailMs: number,
): LiveDurationGuard | null {
  const plan = grant.plan;
  if (at < plan.validFrom || at >= plan.validUntil) return null;
  const length = pendingMs + tailMs;
  const end = at + length;
  for (let day = Math.floor(at / DAY); day * DAY < end; day++) {
    const need = overlap(at, length, day);
    if (need === 0) continue;
    const hold = holdOn(grant, day);
    if (
      !hold ||
      hold.ms < need ||
      hold.from > Math.max(at, day * DAY) ||
      hold.until < Math.min(end, (day + 1) * DAY)
    )
      return null;
  }
  return { grant, startedAt: at, pendingMs, tailMs };
}

/**
 * What the run used per reserved day, through its physical finish and the
 * whole declared tail; null when it ran past its pending bound or a day's
 * hold (the full charge then stays).
 */
export function finishLiveDuration(
  guard: LiveDurationGuard,
  physicalFinishedAt: number,
): LiveDurationCompletion | null {
  const { grant, startedAt, pendingMs, tailMs } = guard;
  if (physicalFinishedAt < startedAt || physicalFinishedAt > startedAt + pendingMs) return null;
  const length = physicalFinishedAt + tailMs - startedAt;
  const actual = [];
  for (const charge of grant.plan.charges) {
    if (!charge.duration) continue;
    const ms = overlap(startedAt, length, charge.day);
    if (ms > charge.duration.ms) return null;
    actual.push({ day: charge.day, ms });
  }
  return {
    protocol: 1,
    operationId: grant.operationId,
    incarnation: grant.plan.incarnation,
    recipientType: grant.plan.recipientType,
    recipient: grant.plan.recipient,
    epoch: grant.plan.epoch,
    finishedAt: physicalFinishedAt,
    actual,
  };
}

/**
 * A ledger deadline in the local clock: anchored where the request was
 * asked (`askedAt`, before the await), never extended by the answer's delay.
 */
export function liveLocalDeadline(
  askedAt: number,
  ledgerAt: number,
  ledgerDeadline: number,
): number {
  return askedAt + Math.max(0, ledgerDeadline - ledgerAt);
}
