// Each task's log-mask matchers kept between log requests, so a request
// reuses or extends them instead of building them from every mask again.
// Memory only: an evicted, hibernated or reset object builds again on its
// next request, with the same masked output.
import type { DoMemoryBudget } from "@fyrden/adapters-cloudflare/git";
import { MaskMatcherCache, type MaskMatcherOutcome } from "@fyrden/domain/ci";

type MemoryReservation = NonNullable<ReturnType<DoMemoryBudget["tryReserve"]>>;

/**
 * The most the kept matchers of one object may hold, by their estimates
 * (`MaskMatcherCache.bytes`), inside the object's memory pool: about two
 * tasks at the full secret allowance. Proposed.
 */
export const MASK_CACHE_BYTES = 8 * 1024 * 1024;

/** What a log request's masking did with its task's kept matchers; `uncached`: not kept after it. */
export type MaskCacheOutcome = MaskMatcherOutcome | "uncached";

interface Kept {
  readonly cache: MaskMatcherCache;
  readonly bytes: number;
  readonly reservation: MemoryReservation;
}

/**
 * The kept matchers of an object's tasks, least recently used first. Each
 * entry holds a reservation of its estimate from the object's memory pool,
 * and all of them together stay within `cap()`. An entry the pool or the cap
 * cannot take is not kept: the next request builds again.
 *
 * The matchers hold mask values and their variants, so an entry lives only
 * while its task's masks are stored: the caller drops it when the log closes,
 * a final store commits or the run is erased, and keeps it after a call only
 * when the log is still open.
 */
export class MaskMatcherCaches {
  readonly #entries = new Map<number, Kept>();
  #bytes = 0;

  constructor(
    private readonly memory: DoMemoryBudget,
    private readonly cap: () => number,
  ) {}

  /**
   * The task's matchers for the masking calls of one request: kept ones if
   * any, else new ones. They are no longer kept: the caller hands them to
   * `keep` before its next await, or lets them go.
   */
  take(task: number): MaskMatcherCache {
    const kept = this.#entries.get(task);
    if (kept === undefined) return new MaskMatcherCache();
    this.#remove(task, kept);
    return kept.cache;
  }

  /** Keeps `cache` as the task's matchers if the cap and the pool take its estimate. */
  keep(task: number, cache: MaskMatcherCache): MaskCacheOutcome {
    const bytes = cache.bytes;
    const cap = this.cap();
    if (bytes > cap) return "uncached";
    // Least recently used first: evict until the new entry fits under the cap.
    for (const [other, kept] of this.#entries) {
      if (this.#bytes + bytes <= cap) break;
      this.#remove(other, kept);
    }
    let reservation = this.memory.tryReserve(bytes);
    // The pool is short: the kept matchers of other tasks give way to this one.
    while (reservation === undefined && this.#entries.size > 0) {
      const [other, kept] = this.#entries.entries().next().value as [number, Kept];
      this.#remove(other, kept);
      reservation = this.memory.tryReserve(bytes);
    }
    if (reservation === undefined) return "uncached";
    this.#entries.set(task, { cache, bytes, reservation });
    this.#bytes += bytes;
    return cache.outcome ?? "uncached";
  }

  /** Drops the task's kept matchers (its masks were deleted). */
  drop(task: number): void {
    const kept = this.#entries.get(task);
    if (kept !== undefined) this.#remove(task, kept);
  }

  /** Drops every task's kept matchers: the run was erased, or a log request needs the room. */
  dropAll(): void {
    for (const [task, kept] of [...this.#entries]) this.#remove(task, kept);
  }

  /** The estimates of the kept matchers, in bytes (for tests and the bound). */
  bytes(): number {
    return this.#bytes;
  }

  #remove(task: number, kept: Kept): void {
    this.#entries.delete(task);
    this.#bytes -= kept.bytes;
    kept.reservation.release();
  }
}
