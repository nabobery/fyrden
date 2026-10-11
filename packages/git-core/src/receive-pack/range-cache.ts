import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import type { StoredBody } from "./body.js";

/**
 * Random reads of a stored body served from a few large blocks, so the
 * second pass of pack indexing (one read per delta and per base, in delta
 * order rather than pack order) costs a storage read per block, not per
 * entry. Blocks are reserved from the memory budget; the least recently
 * used block is dropped first.
 */
export class BodyRangeCache {
  readonly #body: StoredBody;
  readonly #blockBytes: number;
  readonly #maxBlocks: number;
  readonly #memory: MemoryBudget;
  readonly #blocks = new Map<number, { bytes: Uint8Array; reservation: MemoryReservation }>();
  /** Storage reads made, for metrics and tests. */
  reads = 0;

  constructor(body: StoredBody, memory: MemoryBudget, blockBytes: number, maxBlocks: number) {
    if (!Number.isSafeInteger(blockBytes) || blockBytes < 1) throw new RangeError("bad block size");
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) throw new RangeError("bad block count");
    this.#body = body;
    this.#memory = memory;
    this.#blockBytes = blockBytes;
    this.#maxBlocks = maxBlocks;
  }

  /** `length` bytes at `offset` of the body, as a new buffer the caller owns. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.#body.length) {
      throw new RangeError(`range ${offset}+${length} is outside the body (${this.#body.length})`);
    }
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const at = offset + filled;
      const index = Math.floor(at / this.#blockBytes);
      const block = await this.#block(index);
      const start = at - index * this.#blockBytes;
      const take = Math.min(length - filled, block.length - start);
      out.set(block.subarray(start, start + take), filled);
      filled += take;
    }
    return out;
  }

  async #block(index: number): Promise<Uint8Array> {
    const cached = this.#blocks.get(index);
    if (cached) {
      this.#blocks.delete(index);
      this.#blocks.set(index, cached);
      return cached.bytes;
    }
    while (this.#blocks.size >= this.#maxBlocks) {
      const [oldest, entry] = this.#blocks.entries().next().value as [
        number,
        { reservation: MemoryReservation },
      ];
      entry.reservation.release();
      this.#blocks.delete(oldest);
    }
    const start = index * this.#blockBytes;
    const length = Math.min(this.#blockBytes, this.#body.length - start);
    const reservation = await this.#memory.reserve(length);
    try {
      this.reads++;
      const bytes = await this.#body.read(start, length);
      if (bytes.length !== length) throw new RangeError(`stored body gave ${bytes.length} bytes`);
      this.#blocks.set(index, { bytes, reservation });
      return bytes;
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  /** Drops every block and returns its memory. */
  release(): void {
    for (const { reservation } of this.#blocks.values()) reservation.release();
    this.#blocks.clear();
  }
}
