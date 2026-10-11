import { PackError } from "../pack/errors.js";
import type { PackStore } from "../ports/pack-store.js";
import type { ReadStats } from "./stats.js";
import type { ViewPack } from "./view.js";

/**
 * Sequential reads of one pack for a walk in pack order: large ranges
 * (`rangeBytes`, 8 MiB by default) instead of 64 KiB blocks, bypassing the
 * block cache, so a pass over 1 GiB costs about 128 reads, not 16,384
 * (design: read path). Each read starts where the previous one ended, so no
 * byte is read twice; only an entry that runs past the end of the buffer is
 * kept and carried into the next one. A gap in the wanted offsets starts a
 * fresh range at the next wanted entry. Every read but the pack's last is at
 * least `rangeBytes` long.
 */
export class SequentialPackReader {
  readonly #store: Pick<PackStore, "openRange">;
  readonly #pack: ViewPack;
  readonly #rangeBytes: number;
  readonly #stats: ReadStats;
  #buffer: Uint8Array = new Uint8Array(0);
  #bufferStart = 0;

  constructor(
    store: Pick<PackStore, "openRange">,
    pack: ViewPack,
    rangeBytes: number,
    stats: ReadStats,
  ) {
    this.#store = store;
    this.#pack = pack;
    this.#rangeBytes = rangeBytes;
    this.#stats = stats;
  }

  get #bufferEnd(): number {
    return this.#bufferStart + this.#buffer.length;
  }

  /** Bytes at `start` (to at least `minEnd`) when the buffer already holds them; never reads. */
  peek(start: number, minEnd: number): Uint8Array | undefined {
    const end = Math.min(minEnd, this.#pack.bytes);
    if (start < this.#bufferStart || end > this.#bufferEnd || start >= end) return undefined;
    return this.#buffer.subarray(start - this.#bufferStart);
  }

  /**
   * Bytes at `start`, to at least `minEnd` (or the end of the pack), reading
   * forward as needed. Bytes before `start` are dropped: offsets must not
   * go backwards.
   */
  async advance(start: number, minEnd: number): Promise<Uint8Array> {
    const held = this.peek(start, minEnd);
    if (held) return held;
    const end = Math.min(minEnd, this.#pack.bytes);
    if (!Number.isSafeInteger(start) || start < 0 || start >= end) {
      throw new PackError("truncated", `read at ${start} is outside the pack`, start);
    }
    if (start < this.#bufferStart) throw new RangeError("sequential reads cannot go backwards");
    // Keep the part of the buffer from `start` on, if any; otherwise jump to `start`.
    const tail =
      start < this.#bufferEnd ? this.#buffer.subarray(start - this.#bufferStart) : undefined;
    const from = tail ? this.#bufferEnd : start;
    const to = Math.min(this.#pack.bytes, Math.max(end, from + this.#rangeBytes));
    const bytes = await this.#store.openRange(this.#pack.packId, from, to - from);
    this.#stats.storeReads++;
    this.#stats.storeBytes += bytes.length;
    if (bytes.length !== to - from) {
      throw new PackError("truncated", `read of ${to - from} bytes returned ${bytes.length}`, from);
    }
    if (tail && tail.length > 0) {
      const joined = new Uint8Array(tail.length + bytes.length);
      joined.set(tail);
      joined.set(bytes, tail.length);
      this.#buffer = joined;
    } else {
      this.#buffer = bytes;
    }
    this.#bufferStart = start;
    return this.#buffer;
  }
}
