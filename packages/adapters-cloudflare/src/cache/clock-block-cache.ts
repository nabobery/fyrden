import { BLOCK_SIZE, type BlockCache } from "@fyrden/git-core";
import { checkBlockAddress } from "./block-key.js";

/**
 * The in-isolate block cache budget. Proposed: 24 MiB, fixed, inside the
 * 96 MiB a Durable Object isolate plans to use (design: memory admission).
 */
export const DEFAULT_CLOCK_CACHE_BYTES = 24 * 1024 * 1024;

export interface ClockBlockCache extends BlockCache {
  /** Bytes of block data held. Never more than the budget. */
  readonly bytes: number;
  readonly count: number;
}

interface Slot {
  readonly key: string;
  data: Uint8Array;
  referenced: boolean;
}

/**
 * Pack blocks held in the isolate's memory with CLOCK eviction (as JGit's
 * DfsBlockCache): a hit sets the block's reference bit; to make room, the
 * hand sweeps the slots, clearing set bits and evicting the first block
 * whose bit is clear. Keep one per Durable Object instance, so it lives as
 * long as the object. Blocks are copied in and out.
 */
export function createClockBlockCache(maxBytes = DEFAULT_CLOCK_CACHE_BYTES): ClockBlockCache {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < BLOCK_SIZE) {
    throw new RangeError(`a block cache needs at least ${BLOCK_SIZE} bytes`);
  }
  const slots: (Slot | undefined)[] = [];
  const free: number[] = [];
  const index = new Map<string, number>();
  let hand = 0;
  let bytes = 0;

  const keyOf = (scope: string, packId: string, blockIndex: number) => {
    checkBlockAddress(scope, packId, blockIndex);
    // Pack ids and indexes cannot hold ':', so the scope can go last unescaped.
    return `${packId}:${blockIndex}:${scope}`;
  };

  function evictOne(): void {
    // Each pass clears reference bits, so the second pass at the latest evicts.
    for (let steps = 0; steps <= 2 * slots.length; steps++) {
      const at = hand;
      hand = (hand + 1) % slots.length;
      const slot = slots[at];
      if (slot === undefined) continue;
      if (slot.referenced) {
        slot.referenced = false;
        continue;
      }
      slots[at] = undefined;
      free.push(at);
      index.delete(slot.key);
      bytes -= slot.data.length;
      return;
    }
    throw new Error("block cache accounting is inconsistent");
  }

  return {
    get bytes() {
      return bytes;
    },
    get count() {
      return index.size;
    },
    async get(scope, packId, blockIndex) {
      const at = index.get(keyOf(scope, packId, blockIndex));
      const slot = at === undefined ? undefined : slots[at];
      if (slot === undefined) return undefined;
      slot.referenced = true;
      return new Uint8Array(slot.data);
    },
    async put(scope, packId, blockIndex, block) {
      const key = keyOf(scope, packId, blockIndex);
      if (block.length > BLOCK_SIZE) {
        throw new RangeError(`block of ${block.length} bytes exceeds ${BLOCK_SIZE}`);
      }
      const data = new Uint8Array(block);
      const existing = index.get(key);
      if (existing !== undefined) {
        // Packs are immutable: the same block again. Keep the newer copy.
        const slot = slots[existing] as Slot;
        bytes += data.length - slot.data.length;
        slot.data = data;
        slot.referenced = true;
      } else {
        while (bytes + data.length > maxBytes) evictOne();
        const at = free.pop() ?? slots.length;
        slots[at] = { key, data, referenced: false };
        index.set(key, at);
        bytes += data.length;
      }
      while (bytes > maxBytes) evictOne();
    },
  };
}
