/** Bytes held for one operation; release them when it ends. */
export interface MemoryReservation {
  readonly bytes: number;
  /** Returns the bytes to the budget. Releasing twice has no effect. */
  release(): void;
}

/**
 * Admission control for memory-heavy work (pack indexing, walks) inside one
 * Durable Object isolate, whose 128 MB limit is shared by every request it
 * serves. Work reserves its bytes first, so overlapping large operations wait
 * instead of resetting the object.
 */
export interface MemoryBudget {
  /**
   * Waits until `bytes` are free, first come first served. Throws RangeError
   * when `bytes` is not a positive integer or exceeds the whole budget.
   * When `signal` aborts first, the wait ends with the signal's reason and
   * nothing is held; an already aborted signal refuses at once. A budget may
   * also bound every wait itself, so work never waits forever on bytes its
   * own caller holds.
   */
  reserve(bytes: number, signal?: AbortSignal): Promise<MemoryReservation>;
  /** Reserves now, or returns undefined when the bytes are not free (to spill instead). */
  tryReserve(bytes: number): MemoryReservation | undefined;
}
