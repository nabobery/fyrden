import { copyBytes } from "../../src/object/bytes.js";
import { BLOCK_SIZE, type BlockCache } from "../../src/ports/block-cache.js";

export function createMemoryBlockCache(): BlockCache {
  const blocks = new Map<string, Uint8Array>();
  const key = (scope: string, packId: string, blockIndex: number) => {
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0)
      throw new RangeError(`bad block index ${blockIndex}`);
    return JSON.stringify([scope, packId, blockIndex]);
  };
  return {
    async get(scope, packId, blockIndex) {
      const block = blocks.get(key(scope, packId, blockIndex));
      return block && copyBytes(block);
    },
    async put(scope, packId, blockIndex, block) {
      if (block.length > BLOCK_SIZE)
        throw new RangeError(`block of ${block.length} bytes exceeds ${BLOCK_SIZE}`);
      blocks.set(key(scope, packId, blockIndex), copyBytes(block));
    },
  };
}
