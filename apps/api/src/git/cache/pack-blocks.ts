import { createCacheApiBlockCache, createTieredBlockCache } from "@fyrden/adapters-cloudflare";
import type { BlockCache } from "@fyrden/git-core";

/** The Cache API cache that holds pack blocks shared across requests in a colo. */
export const PACK_BLOCK_CACHE = "fyrden-pack-blocks";

/** Where one request's block reads were answered. */
export interface PackBlockStats {
  /** Blocks found in the object's in-memory tier. */
  readonly memoryHits: number;
  /** Blocks found in the Cache API tier (they survive eviction of the object). */
  readonly sharedHits: number;
  /** Blocks in neither tier, read from R2. */
  readonly misses: number;
  /** Cache API calls this tier made (gets and puts), out of the invocation's external allowance. */
  readonly sharedCalls: number;
}

export interface RequestBlockCache {
  readonly cache: BlockCache;
  /** A snapshot of the counts so far. */
  stats(): PackBlockStats;
}

export interface RequestBlockCacheOptions {
  /**
   * The repository's network id. The block tier is network-scoped, so a
   * request may read only blocks of its own network; any other scope throws.
   */
  readonly scope: string;
  /**
   * Most external calls the invocation may have made (by any tier, and
   * outbound fetches) for this tier to make another; see `createCacheApiBlockCache`.
   */
  readonly maxCalls: number;
  /** Opens the shared tier; default `caches.open(PACK_BLOCK_CACHE)`. */
  readonly open?: () => Promise<Cache>;
}

/**
 * The block cache for one request in a repository object: the object's
 * long-lived in-memory tier in front of a Cache API tier, keyed by the
 * repository's network. The Cache API calls of every tier opened in one
 * invocation (each indexing phase or job of an alarm) share the
 * invocation's allowance, and a failed call is a miss.
 *
 * Authorization. The repository object is reached only after the Worker's
 * repository-level access check, and its readers read only packs of its
 * own registry, in its own network. Which objects a request may see is
 * decided before the reader is asked (wants reachable from the refs, the
 * object check); a block cached by a sibling repository in the network
 * can speed up a read, never widen it.
 *
 * Where the runtime has no Cache API, the memory tier serves alone.
 */
export async function openRequestBlockCache(
  memory: BlockCache,
  options: RequestBlockCacheOptions,
): Promise<RequestBlockCache> {
  const counts = { memoryHits: 0, sharedHits: 0, misses: 0 };
  const shared = await openShared(options);
  const countedMemory: BlockCache = {
    async get(scope, packId, blockIndex) {
      const block = await memory.get(scope, packId, blockIndex);
      if (block !== undefined) counts.memoryHits++;
      else if (shared === undefined) counts.misses++;
      return block;
    },
    put: (scope, packId, blockIndex, block) => memory.put(scope, packId, blockIndex, block),
  };
  const countedShared: BlockCache | undefined = shared && {
    async get(scope, packId, blockIndex) {
      const block = await shared.get(scope, packId, blockIndex);
      if (block !== undefined) counts.sharedHits++;
      else counts.misses++;
      return block;
    },
    put: (scope, packId, blockIndex, block) => shared.put(scope, packId, blockIndex, block),
  };
  const tiered = createTieredBlockCache(countedMemory, countedShared);
  const checkScope = (scope: string) => {
    if (scope !== options.scope)
      throw new RangeError("block scope is not this repository's network");
  };
  return {
    cache: {
      get(scope, packId, blockIndex) {
        checkScope(scope);
        return tiered.get(scope, packId, blockIndex);
      },
      put(scope, packId, blockIndex, block) {
        checkScope(scope);
        return tiered.put(scope, packId, blockIndex, block);
      },
    },
    stats: () => ({ ...counts, sharedCalls: shared?.calls ?? 0 }),
  };
}

async function openShared(options: RequestBlockCacheOptions) {
  let cache: Cache;
  try {
    cache = await (options.open ?? (() => caches.open(PACK_BLOCK_CACHE)))();
  } catch {
    return undefined;
  }
  return createCacheApiBlockCache({ cache, maxCalls: options.maxCalls });
}
