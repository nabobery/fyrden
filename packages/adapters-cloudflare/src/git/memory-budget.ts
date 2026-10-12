import type { MemoryBudget, MemoryReservation } from "@fyrden/git-core";

const MiB = 1024 * 1024;

/**
 * Memory budgets for one Durable Object. Workers memory is 128 MB per
 * isolate (verified: https://developers.cloudflare.com/workers/platform/limits/),
 * shared by every request the object serves, so heavy work reserves bytes
 * before it starts. All three numbers are Proposed defaults, tuned from the
 * memory measurements under real packs.
 */
export const DO_MEMORY = {
  /** Usable per object; the rest is headroom for the runtime and requests. */
  usableBytes: 96 * MiB,
  /** Fixed block cache, allocated once. */
  blockCacheBytes: 24 * MiB,
  /** Reserved from by indexing, delta resolution, fetch regeneration, merges and archives. */
  operationPoolBytes: 72 * MiB,
  /**
   * The longest any `reserve` waits before it fails. A request or alarm
   * slice runs for seconds, so a longer wait means the bytes are held by
   * work that is itself waiting (or stuck): failing closed with a clear
   * error beats hanging until the platform stops the invocation.
   */
  maxWaitMs: 60_000,
} as const;

/** A reservation waited longer than the pool allows (`DO_MEMORY.maxWaitMs`). */
export class MemoryWaitTimeoutError extends Error {
  override name = "MemoryWaitTimeoutError";
  constructor(bytes: number, waitMs: number) {
    super(
      `${bytes} bytes of working memory did not become free within ${waitMs} ms: ` +
        "the repository is busy with other large operations; try again",
    );
  }
}

export interface MemoryBudgetStats {
  readonly totalBytes: number;
  readonly reservedBytes: number;
  /** The most ever reserved at once. Never above `totalBytes`. */
  readonly peakBytes: number;
  readonly waiting: number;
}

export interface DoMemoryBudget extends MemoryBudget {
  /**
   * Waits up to `waitMs` for the bytes, first come first served. Returns
   * undefined when the wait ends without them: the caller then spills to
   * R2 scratch or reschedules itself on the alarm.
   */
  reserveWithin(bytes: number, waitMs: number): Promise<MemoryReservation | undefined>;
  stats(): MemoryBudgetStats;
}

interface Waiter {
  readonly bytes: number;
  grant(reservation: MemoryReservation): void;
}

export interface DoMemoryBudgetOptions {
  /** The longest a `reserve` waits (default `DO_MEMORY.maxWaitMs`). */
  readonly maxWaitMs?: number;
}

/**
 * The operation pool of one Durable Object instance. In memory only: a
 * reservation belongs to a running request and disappears with the
 * instance, so nothing needs to survive eviction. Waiters are served in
 * arrival order; a large waiter at the front holds back smaller ones, so it
 * cannot starve.
 *
 * Several objects can share one isolate (**unverified** how often in
 * production), and this budget does not see the others. The per-object
 * figures keep that headroom.
 */
export function createDoMemoryBudget(
  totalBytes: number = DO_MEMORY.operationPoolBytes,
  options: DoMemoryBudgetOptions = {},
): DoMemoryBudget {
  const maxWaitMs = options.maxWaitMs ?? DO_MEMORY.maxWaitMs;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
    throw new RangeError(`bad memory budget ${totalBytes}`);
  let reserved = 0;
  let peak = 0;
  const waiting: Waiter[] = [];

  function check(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new RangeError(`bad reservation size ${bytes}`);
    if (bytes > totalBytes)
      throw new RangeError(`${bytes} bytes exceed the whole budget of ${totalBytes}`);
  }

  function grantNow(bytes: number): MemoryReservation {
    reserved += bytes;
    peak = Math.max(peak, reserved);
    let released = false;
    return {
      bytes,
      release() {
        if (released) return;
        released = true;
        reserved -= bytes;
        serveWaiters();
      },
    };
  }

  function serveWaiters(): void {
    while (waiting.length > 0) {
      const next = waiting[0] as Waiter;
      if (next.bytes > totalBytes - reserved) return;
      waiting.shift();
      next.grant(grantNow(next.bytes));
    }
  }

  /**
   * Queues a waiter. It leaves the queue when granted, when `waitMs`
   * passes (`onTimeout` decides the outcome) or when `signal` aborts
   * (rejected with its reason).
   */
  function enqueue<T>(
    bytes: number,
    waitMs: number,
    onTimeout: () => T,
    signal?: AbortSignal,
  ): Promise<MemoryReservation | T> {
    return new Promise((resolve, reject) => {
      const leave = (): boolean => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const at = waiting.indexOf(waiter);
        if (at < 0) return false;
        waiting.splice(at, 1);
        // Leaving the queue may unblock smaller waiters behind this one.
        serveWaiters();
        return true;
      };
      const onAbort = () => {
        if (leave()) reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        if (!leave()) return;
        try {
          resolve(onTimeout());
        } catch (error) {
          reject(error);
        }
      }, waitMs);
      const waiter: Waiter = {
        bytes,
        grant(reservation) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(reservation);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(waiter);
    });
  }

  const free = () => totalBytes - reserved;

  return {
    async reserve(bytes, signal) {
      check(bytes);
      signal?.throwIfAborted();
      if (waiting.length === 0 && bytes <= free()) return grantNow(bytes);
      return enqueue(
        bytes,
        maxWaitMs,
        () => {
          throw new MemoryWaitTimeoutError(bytes, maxWaitMs);
        },
        signal,
      ) as Promise<MemoryReservation>;
    },
    tryReserve(bytes) {
      check(bytes);
      return waiting.length === 0 && bytes <= free() ? grantNow(bytes) : undefined;
    },
    async reserveWithin(bytes, waitMs) {
      check(bytes);
      if (waiting.length === 0 && bytes <= free()) return grantNow(bytes);
      if (waitMs <= 0) return undefined;
      return enqueue(bytes, Math.min(waitMs, maxWaitMs), () => undefined);
    },
    stats() {
      return { totalBytes, reservedBytes: reserved, peakBytes: peak, waiting: waiting.length };
    },
  };
}

/**
 * Runs heavy work under a reservation from `budget`, waiting up to `waitMs`
 * for the bytes. When they do not come in time the work does not start and
 * the result says so: the caller spills to R2 scratch or continues on a
 * later alarm. The reservation is released however the work ends.
 */
export async function withReservation<T>(
  budget: DoMemoryBudget,
  bytes: number,
  waitMs: number,
  work: () => Promise<T>,
): Promise<{ admitted: true; value: T } | { admitted: false }> {
  const reservation = await budget.reserveWithin(bytes, waitMs);
  if (!reservation) return { admitted: false };
  try {
    return { admitted: true, value: await work() };
  } finally {
    reservation.release();
  }
}
