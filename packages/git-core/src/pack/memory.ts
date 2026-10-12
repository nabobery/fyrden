import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import { PackError } from "./errors.js";

/**
 * The most bytes one byte of zlib input can inflate to (verified:
 * https://zlib.net/zlib_tech.html, "the theoretical limit for the zlib
 * format ... is 1032:1").
 */
export const MAX_INFLATE_RATIO = 1032;

/**
 * `memory.reserve` for pack parsing. A budget refuses a reservation larger
 * than its whole pool with a RangeError; here that becomes a PackError
 * (`exceeds-memory-budget`), so a pack this server cannot hold is refused
 * like any other bad pack. Other errors (an abort, a wait that timed out)
 * pass through unchanged.
 */
export async function reservePackMemory(
  memory: MemoryBudget,
  bytes: number,
  what: string,
  offset?: number,
): Promise<MemoryReservation> {
  try {
    return await memory.reserve(bytes);
  } catch (error) {
    throw asPackError(error, bytes, what, offset);
  }
}

function asPackError(error: unknown, bytes: number, what: string, offset?: number): unknown {
  // A bad size is a bug in the caller, not in the pack: keep its RangeError.
  if (!(error instanceof RangeError) || !Number.isSafeInteger(bytes) || bytes <= 0) return error;
  return new PackError(
    "exceeds-memory-budget",
    `${what} needs ${bytes} bytes, more than this server holds for one operation`,
    offset,
  );
}

/**
 * The memory one large entry's inflate holds, reserved in proportion to
 * the zlib bytes that have actually arrived rather than the size its header
 * declares: a few bytes declaring 32 MiB hold a few KiB. Grows before each
 * inflate attempt; without waiting while it holds part (so two parsers
 * cannot each hold half and wait on the other) when the budget is busy.
 */
export class EntryReservation {
  readonly #memory: MemoryBudget;
  readonly #size: number;
  readonly #offset: number;
  #held: MemoryReservation[] = [];
  #bytes = 0;

  constructor(memory: MemoryBudget, size: number, offset: number) {
    this.#memory = memory;
    this.#size = size;
    this.#offset = offset;
  }

  /** Before inflating `compressed` bytes: holds them plus the most they can inflate to. */
  async cover(compressed: number): Promise<void> {
    const bytes = compressed + Math.min(this.#size + 1, compressed * MAX_INFLATE_RATIO);
    if (bytes <= this.#bytes) return;
    const what = `an entry of ${this.#size} bytes`;
    let more: MemoryReservation | undefined;
    try {
      more = this.#memory.tryReserve(bytes - this.#bytes);
    } catch (error) {
      throw asPackError(error, bytes - this.#bytes, what, this.#offset);
    }
    if (more) {
      this.#held.push(more);
      this.#bytes = bytes;
      return;
    }
    this.release();
    this.#held = [await reservePackMemory(this.#memory, bytes, what, this.#offset)];
    this.#bytes = bytes;
  }

  release(): void {
    for (const reservation of this.#held) reservation.release();
    this.#held = [];
    this.#bytes = 0;
  }
}
