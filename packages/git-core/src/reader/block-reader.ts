import { PackError } from "../pack/errors.js";
import { BLOCK_SIZE, type BlockCache } from "../ports/block-cache.js";
import type { PackStore } from "../ports/pack-store.js";
import type { ReadStats } from "./stats.js";
import type { ViewPack } from "./view.js";

/**
 * Bytes of a pack at `start`, at least up to `minEnd` (or the end of the
 * pack). May return more.
 */
export type PackBytesSource = (
  pack: ViewPack,
  start: number,
  minEnd: number,
) => Promise<Uint8Array>;

/**
 * Random reads through the block cache: whole 64 KiB blocks, aligned to
 * multiples of BLOCK_SIZE (the last block of a pack may be shorter). A run
 * of consecutive missing blocks is fetched with one `openRange` and then
 * put into the cache block by block. A failed put is counted, not thrown:
 * the bytes are already in hand.
 */
export class BlockReader {
  readonly #scope: string;
  readonly #store: Pick<PackStore, "openRange">;
  readonly #cache: BlockCache | undefined;
  readonly #stats: ReadStats;

  constructor(
    scope: string,
    store: Pick<PackStore, "openRange">,
    cache: BlockCache | undefined,
    stats: ReadStats,
  ) {
    this.#scope = scope;
    this.#store = store;
    this.#cache = cache;
    this.#stats = stats;
  }

  /** The bytes from `start` to the end of the block holding `minEnd - 1`. */
  readonly read: PackBytesSource = async (pack, start, minEnd) => {
    const end = Math.min(minEnd, pack.bytes);
    if (!Number.isSafeInteger(start) || start < 0 || start >= end) {
      throw new PackError("truncated", `read at ${start} is outside the pack`, start);
    }
    const first = Math.floor(start / BLOCK_SIZE);
    const last = Math.floor((end - 1) / BLOCK_SIZE);
    const blocks = await this.#blocks(pack, first, last);
    const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const block of blocks) {
      out.set(block, at);
      at += block.length;
    }
    return out.subarray(start - first * BLOCK_SIZE);
  };

  async #blocks(pack: ViewPack, first: number, last: number): Promise<Uint8Array[]> {
    const cache = this.#cache;
    const blocks: (Uint8Array | undefined)[] = cache
      ? await Promise.all(
          range(first, last).map(async (index) => {
            const block = await cache.get(this.#scope, pack.packId, index);
            // A block of the wrong length is not this pack's block: read it again.
            return block?.length === blockLength(pack, index) ? block : undefined;
          }),
        )
      : new Array(last - first + 1).fill(undefined);
    const puts: Promise<void>[] = [];
    for (let k = 0; k < blocks.length; ) {
      if (blocks[k] !== undefined) {
        this.#stats.blockHits++;
        k++;
        continue;
      }
      let runEnd = k;
      while (runEnd + 1 < blocks.length && blocks[runEnd + 1] === undefined) runEnd++;
      const offset = (first + k) * BLOCK_SIZE;
      const length = Math.min((first + runEnd + 1) * BLOCK_SIZE, pack.bytes) - offset;
      const bytes = await this.#store.openRange(pack.packId, offset, length);
      this.#stats.storeReads++;
      this.#stats.storeBytes += bytes.length;
      if (bytes.length !== length) {
        throw new PackError(
          "truncated",
          `read of ${length} bytes returned ${bytes.length}`,
          offset,
        );
      }
      for (let j = k; j <= runEnd; j++) {
        const block = bytes.subarray((j - k) * BLOCK_SIZE, (j - k + 1) * BLOCK_SIZE);
        blocks[j] = block;
        this.#stats.blockMisses++;
        if (cache) {
          puts.push(
            cache.put(this.#scope, pack.packId, first + j, block).catch(() => {
              this.#stats.cachePutErrors++;
            }),
          );
        }
      }
      k = runEnd + 1;
    }
    await Promise.all(puts);
    return blocks as Uint8Array[];
  }
}

function blockLength(pack: ViewPack, index: number): number {
  return Math.min(BLOCK_SIZE, pack.bytes - index * BLOCK_SIZE);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
