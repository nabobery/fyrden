import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import type { PackId } from "../ports/pack-store.js";

/** Reads `length` bytes at `offset` of a stored pack (`PackStore.openRange` fits). */
export type PackRangeRead = (packId: PackId, offset: number, length: number) => Promise<Uint8Array>;

/**
 * Serves small reads that move forward through a pack from one large range
 * read at a time, so a sequential pass over a pack costs about one storage
 * read per window, not one per entry. The window is
 * reserved from the memory budget before it is read.
 */
export class WindowReader {
  readonly #read: PackRangeRead;
  readonly #windowBytes: number;
  readonly #memory: MemoryBudget;
  #packId: PackId | undefined;
  #start = 0;
  #bytes: Uint8Array = new Uint8Array(0);
  #reservation: MemoryReservation | undefined;

  constructor(read: PackRangeRead, windowBytes: number, memory: MemoryBudget) {
    if (!Number.isSafeInteger(windowBytes) || windowBytes < 1) {
      throw new RangeError(`window size must be a positive integer, not ${windowBytes}`);
    }
    this.#read = read;
    this.#windowBytes = windowBytes;
    this.#memory = memory;
  }

  /**
   * `length` bytes at `offset`, as a view into the window (valid until the
   * next call). A new window starts at `offset` and never extends past
   * `limit`.
   */
  async bytes(packId: PackId, offset: number, length: number, limit: number): Promise<Uint8Array> {
    const at = offset - this.#start;
    if (packId === this.#packId && at >= 0 && at + length <= this.#bytes.length) {
      return this.#bytes.subarray(at, at + length);
    }
    const size = Math.min(Math.max(this.#windowBytes, length), limit - offset);
    if (size < length) throw new RangeError(`read of ${length} bytes at ${offset} passes ${limit}`);
    this.release();
    this.#reservation = await this.#memory.reserve(size);
    const bytes = await this.#read(packId, offset, size);
    if (bytes.length !== size) {
      throw new RangeError(`pack ${packId} gave ${bytes.length} bytes at ${offset}, not ${size}`);
    }
    this.#packId = packId;
    this.#start = offset;
    this.#bytes = bytes;
    return bytes.subarray(0, length);
  }

  release(): void {
    this.#reservation?.release();
    this.#reservation = undefined;
    this.#packId = undefined;
    this.#bytes = new Uint8Array(0);
  }
}
