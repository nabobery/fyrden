import type { BlockCache } from "@fyrden/git-core";

/**
 * The in-isolate tier in front of an optional shared tier (the Cache API).
 * A get tries memory, then the shared tier, and copies a shared hit into
 * memory; a put fills both. Without a shared tier (Free plans, workers.dev,
 * or turned off by configuration) this is the memory tier alone. Build one
 * per request around the Durable Object's long-lived memory tier and a
 * per-request shared tier, so the shared tier's call budget is per request.
 */
export function createTieredBlockCache(memory: BlockCache, shared?: BlockCache): BlockCache {
  return {
    async get(scope, packId, blockIndex) {
      const held = await memory.get(scope, packId, blockIndex);
      if (held !== undefined || shared === undefined) return held;
      const block = await shared.get(scope, packId, blockIndex);
      if (block !== undefined) await memory.put(scope, packId, blockIndex, block);
      return block;
    },
    async put(scope, packId, blockIndex, block) {
      await Promise.all([
        memory.put(scope, packId, blockIndex, block),
        shared?.put(scope, packId, blockIndex, block),
      ]);
    },
  };
}
