import { BLOCK_SIZE, type BlockCache } from "@fyrden/git-core";
import { admitExternalCall } from "../obs/invocation.js";
import { checkBlockAddress } from "./block-key.js";

/*
 * The colo-wide block tier, on the Workers Cache API. It survives Durable
 * Object eviction, unlike the in-isolate tier.
 *
 * Budget. Cache API calls count against the per-invocation subrequest
 * limit: 50 on Free, 1,000 on Paid (verified, developers.cloudflare.com/
 * workers/platform/limits/). Measured on Workers Free
 * (2026-10-10): matches and puts alike stop after 50 with "Too many
 * subrequests by single Worker invocation.", Cache API calls and outbound
 * `fetch` share those 50, R2 binding calls count against the separate
 * 1,000 internal-services budget, and a Durable Object gets a fresh budget
 * per incoming request. So the call budget belongs to the invocation, not
 * to an instance: an instance calls the Cache API only while the invocation
 * (every tier in it, outbound fetches included) has made fewer than
 * `maxCalls` external calls. Once it is spent, or when a call fails, `get`
 * reports a miss and `put` does nothing, and reads fall back to the pack
 * store: this tier is optional.
 *
 * Privacy. This tier is network-scoped and internal: it is consulted only
 * after the repository-level object check, never for a response cache.
 * Keys sit under a reserved `.invalid` host (RFC 2606), which no route
 * serves. `caches.default` is the zone cache that `fetch` also
 * reads through (verified, developers.cloudflare.com/workers/reference/
 * how-the-cache-works/); pass a namespaced cache from `caches.open` to
 * keep blocks apart from it. Cache operations are functional only for
 * Workers on custom domains (verified, developers.cloudflare.com/workers/
 * runtime-apis/cache/), yet on workers.dev the calls still count against
 * the budget (measured, same run), which is one reason the tier is
 * optional.
 */

/** Proposed default call budget per invocation: under Free's 50, leaving room for other calls. */
export const DEFAULT_CACHE_API_CALLS = 40;
/** Blocks never change; this only bounds how long a colo keeps one. Proposed: 30 days. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const KEY_ORIGIN = "https://pack-blocks.fyrden.invalid";

export interface CacheApiBlockCacheOptions {
  /** Default: `caches.default`. */
  readonly cache?: Cache;
  /**
   * Most external calls (this tier's gets and puts, other tiers' and outbound
   * fetches) the invocation may have made for this tier to make another.
   * Default 40; Paid can raise it.
   */
  readonly maxCalls?: number;
}

export interface CacheApiBlockCache extends BlockCache {
  /** Cache API calls made. */
  readonly calls: number;
  /** Calls not made because the budget was spent. */
  readonly skipped: number;
  /** Calls that failed (answered as a miss, or dropped). */
  readonly failed: number;
}

/** The cache key URL of a block: scope, pack id and block index, all validated first. */
export function blockCacheUrl(scope: string, packId: string, blockIndex: number): string {
  checkBlockAddress(scope, packId, blockIndex);
  return `${KEY_ORIGIN}/v1/${scope}/${packId}/${blockIndex}`;
}

/** A Cache API block tier; its calls count against the current invocation's allowance. */
export function createCacheApiBlockCache(
  options: CacheApiBlockCacheOptions = {},
): CacheApiBlockCache {
  const maxCalls = options.maxCalls ?? DEFAULT_CACHE_API_CALLS;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) {
    throw new RangeError(`bad Cache API call budget ${maxCalls}`);
  }
  const cache = options.cache ?? caches.default;
  let calls = 0;
  let skipped = 0;
  let failed = 0;
  const spend = () => {
    if (!admitExternalCall(maxCalls, calls)) {
      skipped++;
      return false;
    }
    calls++;
    return true;
  };

  return {
    get calls() {
      return calls;
    },
    get skipped() {
      return skipped;
    },
    get failed() {
      return failed;
    },
    async get(scope, packId, blockIndex) {
      const url = blockCacheUrl(scope, packId, blockIndex);
      if (!spend()) return undefined;
      let block: Uint8Array;
      try {
        const response = await cache.match(url);
        if (response === undefined) return undefined;
        block = new Uint8Array(await response.arrayBuffer());
      } catch {
        // The platform refused the call (subrequest limit) or the cache failed: a miss.
        failed++;
        return undefined;
      }
      // Not a block this tier wrote: treat as a miss.
      return block.length <= BLOCK_SIZE ? block : undefined;
    },
    async put(scope, packId, blockIndex, block) {
      const url = blockCacheUrl(scope, packId, blockIndex);
      if (block.length > BLOCK_SIZE) {
        throw new RangeError(`block of ${block.length} bytes exceeds ${BLOCK_SIZE}`);
      }
      if (!spend()) return;
      try {
        await cache.put(
          url,
          new Response(new Uint8Array(block), {
            headers: {
              "content-type": "application/octet-stream",
              "cache-control": `max-age=${MAX_AGE_SECONDS}, immutable`,
            },
          }),
        );
      } catch {
        failed++;
      }
    },
  };
}
