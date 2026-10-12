import type { MemoryBudget, MemoryReservation } from "../../src/ports/memory-budget.js";

/** A first-come-first-served byte budget, as one Durable Object isolate would hold. */
export function createMemoryBudget(totalBytes: number): MemoryBudget {
  let free = totalBytes;
  const waiting: { bytes: number; grant: (r: MemoryReservation) => void }[] = [];

  function serve() {
    // Grant waiters in order; a large waiter at the front blocks smaller ones behind it.
    while (waiting.length > 0 && (waiting[0] as { bytes: number }).bytes <= free) {
      const next = waiting.shift() as (typeof waiting)[number];
      next.grant(reservation(next.bytes));
    }
  }

  function check(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new RangeError(`bad reservation size ${bytes}`);
    if (bytes > totalBytes)
      throw new RangeError(`${bytes} bytes exceed the whole budget of ${totalBytes}`);
  }

  function reservation(bytes: number): MemoryReservation {
    free -= bytes;
    let released = false;
    return {
      bytes,
      release() {
        if (released) return;
        released = true;
        free += bytes;
        serve();
      },
    };
  }

  return {
    async reserve(bytes, signal) {
      check(bytes);
      signal?.throwIfAborted();
      if (waiting.length === 0 && bytes <= free) return reservation(bytes);
      return new Promise((resolve, reject) => {
        const waiter = {
          bytes,
          grant: (r: MemoryReservation) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(r);
          },
        };
        const onAbort = () => {
          const at = waiting.indexOf(waiter);
          if (at < 0) return;
          waiting.splice(at, 1);
          reject(signal?.reason);
          // Leaving the queue may unblock smaller waiters behind this one.
          serve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting.push(waiter);
      });
    },
    tryReserve(bytes) {
      check(bytes);
      return waiting.length === 0 && bytes <= free ? reservation(bytes) : undefined;
    },
  };
}
