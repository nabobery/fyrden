import type { MemoryBudget, MemoryReservation } from "@fyrden/git-core";

const MiB = 1024 * 1024;

/**
 * Memory budgets for one Durable Object. Workers memory is 128 MB per
 * isolate (verified: https://developers.cloudflare.com/workers/platform/limits/),
 * shared by every request the object serves, so heavy work reserves bytes
 * before it starts. All four sizes are Proposed defaults, tuned from the
 * memory measurements under real packs.
 */
export const DO_MEMORY = {
  /** Usable per object; the rest is headroom for the runtime and requests. */
  usableBytes: 96 * MiB,
  /** Fixed pack block cache, allocated as it fills. */
  blockCacheBytes: 16 * MiB,
  /** Fixed pack index cache (`PackIndexCache`), allocated as it fills. */
  indexCacheBytes: 8 * MiB,
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
  /**
   * Starts an operation that reserves in steps (a fetch plan, an indexing
   * phase). The caller holds nothing yet: it waits, behind every other
   * waiter, for `bytes`, the most the operation holds at once besides what
   * grows with its input, then the operation reserves from them: one that
   * fits what is left of them is granted at once. One past them waits in
   * arrival order with every other reservation, ahead of operations not
   * yet started, until the pool's limit: operations that all need more
   * than their share at once can still wait on one another.
   */
  begin(bytes: number, signal?: AbortSignal): Promise<OperationMemory>;
  stats(): MemoryBudgetStats;
}

/** A started operation's memory (`DoMemoryBudget.begin`). */
export interface OperationMemory extends MemoryBudget {
  /**
   * Ends the operation: its share goes back to the pool, its waiters fail,
   * and it reserves nothing more. Reservations it made past its share stay
   * held until released. Calling it twice has no effect.
   */
  release(): void;
}

/** What a started operation holds of its share. */
interface Share {
  readonly bytes: number;
  used: number;
  ended: boolean;
}

interface Waiter {
  readonly bytes: number;
  /** Set for a reservation of a started operation past its share. */
  readonly share?: Share;
  grant(reservation: MemoryReservation): void;
  fail(error: Error): void;
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
 * cannot starve. Operations not yet started (`begin`) wait behind every
 * other waiter, in an order of their own: they hold nothing yet, while
 * any other waiter may belong to work under way. A steady stream of other
 * reservations can keep one from starting until its wait's limit.
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
  /** Operations waiting for their share (`begin`): served once `waiting` is empty. */
  const starting: Waiter[] = [];

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

  /** `bytes` of an operation's share, given back to the share on release. */
  function grantShared(share: Share, bytes: number): MemoryReservation {
    share.used += bytes;
    let released = false;
    return {
      bytes,
      release() {
        if (released) return;
        released = true;
        if (share.ended) return;
        share.used -= bytes;
        serveWaiters();
      },
    };
  }

  const fitsShare = (share: Share, bytes: number) =>
    !share.ended && bytes <= share.bytes - share.used;
  /** Whether the operation already waits for more: its later reservations wait behind it. */
  const waitsFor = (share: Share) => waiting.some((waiter) => waiter.share === share);

  /**
   * Grants the waiters of operations that their own share now covers, in
   * each operation's order, wherever they are in the queue: they take
   * nothing from the pool. Whether it granted any.
   */
  function serveFromShares(): boolean {
    let served = false;
    const behind = new Set<Share>();
    for (const next of [...waiting]) {
      if (!next.share || behind.has(next.share)) continue;
      if (!fitsShare(next.share, next.bytes)) {
        behind.add(next.share);
        continue;
      }
      waiting.splice(waiting.indexOf(next), 1);
      next.grant(grantShared(next.share, next.bytes));
      served = true;
    }
    return served;
  }

  /**
   * Grants waiters in arrival order, those of `waiting` and then those of
   * `starting`, until the first that does not fit; nothing behind it is
   * served. An operation's waiter at the front takes its own share first.
   * Whether it granted any.
   */
  function serveFromPool(): boolean {
    let served = false;
    for (const queue of [waiting, starting]) {
      while (queue.length > 0) {
        const next = queue[0] as Waiter;
        const { share } = next;
        if (share && fitsShare(share, next.bytes)) {
          queue.shift();
          next.grant(grantShared(share, next.bytes));
        } else if (next.bytes <= totalBytes - reserved) {
          queue.shift();
          next.grant(grantNow(next.bytes));
        } else return served;
        served = true;
      }
    }
    return served;
  }

  function serveWaiters(): void {
    // A grant from the pool can put an operation's waiter at the front of
    // its order, so each pass may let the other serve more.
    for (let served = true; served; ) {
      served = serveFromShares();
      served = serveFromPool() || served;
    }
  }

  /**
   * Queues a waiter in `queue`. It leaves the queue when granted, when
   * `waitMs` passes (`onTimeout` decides the outcome), when `signal` aborts
   * (rejected with its reason) or when it fails (its operation ended).
   */
  function enqueue<T>(
    queue: Waiter[],
    bytes: number,
    waitMs: number,
    onTimeout: () => T,
    signal?: AbortSignal,
    share?: Share,
  ): Promise<MemoryReservation | T> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const leave = (): boolean => {
        settle();
        const at = queue.indexOf(waiter);
        if (at < 0) return false;
        queue.splice(at, 1);
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
        ...(share ? { share } : {}),
        grant(reservation) {
          settle();
          resolve(reservation);
        },
        fail(error) {
          settle();
          reject(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }

  /** Whether `bytes` can be granted from the pool now, ahead of operations not yet started. */
  const fitsNow = (bytes: number) => waiting.length === 0 && bytes <= totalBytes - reserved;
  const timedOut = (bytes: number) => () => {
    throw new MemoryWaitTimeoutError(bytes, maxWaitMs);
  };

  /** The memory of an operation whose share is `base`. */
  function operation(base: MemoryReservation): OperationMemory {
    const share: Share = { bytes: base.bytes, used: 0, ended: false };
    const open = () => {
      if (share.ended) throw new Error("the operation has ended and released its memory");
    };
    return {
      async reserve(bytes, signal) {
        check(bytes);
        signal?.throwIfAborted();
        open();
        if (!waitsFor(share) && fitsShare(share, bytes)) return grantShared(share, bytes);
        if (fitsNow(bytes)) return grantNow(bytes);
        return enqueue(waiting, bytes, maxWaitMs, timedOut(bytes), signal, share);
      },
      tryReserve(bytes) {
        check(bytes);
        open();
        if (waitsFor(share)) return undefined;
        if (fitsShare(share, bytes)) return grantShared(share, bytes);
        return fitsNow(bytes) ? grantNow(bytes) : undefined;
      },
      release() {
        if (share.ended) return;
        share.ended = true;
        for (const next of waiting.filter((waiter) => waiter.share === share)) {
          waiting.splice(waiting.indexOf(next), 1);
          next.fail(new Error("the operation ended while it waited for memory"));
        }
        base.release();
      },
    };
  }

  return {
    async reserve(bytes, signal) {
      check(bytes);
      signal?.throwIfAborted();
      if (fitsNow(bytes)) return grantNow(bytes);
      return enqueue(waiting, bytes, maxWaitMs, timedOut(bytes), signal);
    },
    tryReserve(bytes) {
      check(bytes);
      return fitsNow(bytes) ? grantNow(bytes) : undefined;
    },
    async reserveWithin(bytes, waitMs) {
      check(bytes);
      if (fitsNow(bytes)) return grantNow(bytes);
      if (waitMs <= 0) return undefined;
      return enqueue(waiting, bytes, Math.min(waitMs, maxWaitMs), () => undefined);
    },
    async begin(bytes, signal) {
      check(bytes);
      signal?.throwIfAborted();
      if (starting.length === 0 && fitsNow(bytes)) return operation(grantNow(bytes));
      return operation(
        (await enqueue(starting, bytes, maxWaitMs, timedOut(bytes), signal)) as MemoryReservation,
      );
    },
    stats() {
      return {
        totalBytes,
        reservedBytes: reserved,
        peakBytes: peak,
        waiting: waiting.length + starting.length,
      };
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
