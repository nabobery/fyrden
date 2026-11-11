import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";

/** A reservation past what was paid for: a defect in the proof, not a pack too large to hold. */
export class PrepaidMemoryExceeded extends Error {
  override name = "PrepaidMemoryExceeded";
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`a reservation of ${bytes} bytes passes the ${limit} bytes paid for`);
  }
}

export interface PrepaidMemory extends MemoryBudget {
  held(): number;
  peak(): number;
}

/**
 * A budget for a reader whose memory its owner reserved before opening it.
 * It takes nothing further and never waits: it counts what the reader says
 * it holds, and throws past `limit`, so a reservation nobody foresaw is an
 * error rather than a silent grant. The error isn't a `RangeError`, which
 * `reservePackMemory` would turn into a pack refusal. `tryReserve` throws too,
 * rather than answering undefined: a spill would hide the same defect.
 */
export function createPrepaidMemory(limit: number): PrepaidMemory {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`bad prepaid memory limit ${limit}`);
  }
  let held = 0;
  let peak = 0;
  const grant = (bytes: number): MemoryReservation => {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new RangeError(`bad reservation of ${bytes} bytes`);
    }
    if (held + bytes > limit) throw new PrepaidMemoryExceeded(bytes, limit);
    held += bytes;
    peak = Math.max(peak, held);
    let released = false;
    return {
      bytes,
      release() {
        if (released) return;
        released = true;
        held -= bytes;
      },
    };
  };
  return {
    async reserve(bytes, signal) {
      signal?.throwIfAborted();
      return grant(bytes);
    },
    tryReserve: grant,
    held: () => held,
    peak: () => peak,
  };
}
