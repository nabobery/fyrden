// The block cache tiers inside workerd: the shared BlockCache contract for
// each, then what is particular to each tier. Every Cache API test opens its
// own named cache (uniqueId), because storage is shared within a file.
import { asPackId, BLOCK_SIZE, type BlockCache } from "@fyrden/git-core";
import { describeBlockCacheContract } from "@fyrden/git-core/testing";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import {
  blockCacheUrl,
  createCacheApiBlockCache,
  DEFAULT_CACHE_API_CALLS,
} from "../../src/cache/cache-api-block-cache.js";
import { createClockBlockCache } from "../../src/cache/clock-block-cache.js";
import { createTieredBlockCache } from "../../src/cache/tiered-block-cache.js";
import { createFakeDataset } from "../../src/obs/fake-dataset.js";
import { countSubrequests, createMetrics, measureInvocation } from "../../src/obs/index.js";

const PACK = asPackId("01J00000000000000000000000");
const block = (fill: number, length = BLOCK_SIZE) => new Uint8Array(length).fill(fill);
const namedCache = () => caches.open(uniqueId("blocks"));

describeBlockCacheContract("in-isolate CLOCK", async () => createClockBlockCache());
describeBlockCacheContract("Cache API", async () =>
  createCacheApiBlockCache({ cache: await namedCache() }),
);
describeBlockCacheContract("Cache API on caches.default", async () => {
  // caches.default is shared by the whole file: a scope of its own keeps it empty.
  const cache = createCacheApiBlockCache();
  const scope = uniqueId("s");
  return scoped(cache, scope);
});
describeBlockCacheContract("memory then Cache API", async () =>
  createTieredBlockCache(
    createClockBlockCache(),
    createCacheApiBlockCache({ cache: await namedCache() }),
  ),
);

/** Prefixes every scope, so a test on a shared cache starts empty. */
function scoped(inner: BlockCache, prefix: string): BlockCache {
  return {
    get: (scope, packId, index) => inner.get(`${prefix}${scope}`, packId, index),
    put: (scope, packId, index, data) => inner.put(`${prefix}${scope}`, packId, index, data),
  };
}

describe("in-isolate CLOCK block cache", () => {
  it("never holds more than its budget", async () => {
    const cache = createClockBlockCache(4 * BLOCK_SIZE);
    for (let i = 0; i < 20; i++) {
      await cache.put("net_a", PACK, i, block(i, BLOCK_SIZE - (i % 3)));
      expect(cache.bytes).toBeLessThanOrEqual(4 * BLOCK_SIZE);
    }
    expect(cache.count).toBeLessThanOrEqual(4);
    expect(await cache.get("net_a", PACK, 19)).toEqual(block(19, BLOCK_SIZE - 1));
  });

  it("gives a recently used block a second chance", async () => {
    const cache = createClockBlockCache(3 * BLOCK_SIZE);
    for (let i = 0; i < 3; i++) await cache.put("net_a", PACK, i, block(i));
    await cache.get("net_a", PACK, 0);
    await cache.put("net_a", PACK, 3, block(3));
    // Block 0 was referenced, so the hand passed it and evicted block 1.
    expect(await cache.get("net_a", PACK, 0)).toBeDefined();
    expect(await cache.get("net_a", PACK, 1)).toBeUndefined();
    expect(await cache.get("net_a", PACK, 2)).toBeDefined();
    expect(await cache.get("net_a", PACK, 3)).toBeDefined();
  });

  it("replaces a block put twice without growing", async () => {
    const cache = createClockBlockCache(2 * BLOCK_SIZE);
    await cache.put("net_a", PACK, 0, block(1, 100));
    await cache.put("net_a", PACK, 0, block(2, 200));
    expect(cache.bytes).toBe(200);
    expect(cache.count).toBe(1);
    expect(await cache.get("net_a", PACK, 0)).toEqual(block(2, 200));
  });

  it("refuses a budget below one block and malformed addresses", async () => {
    expect(() => createClockBlockCache(BLOCK_SIZE - 1)).toThrow(RangeError);
    const cache = createClockBlockCache();
    await expect(cache.get("net a", PACK, 0)).rejects.toThrow(RangeError);
    await expect(cache.get("net_a", asPackId(PACK).toLowerCase() as never, 0)).rejects.toThrow(
      RangeError,
    );
  });
});

describe("Cache API block tier", () => {
  it("keys blocks by scope, pack id and index under a reserved host", () => {
    expect(blockCacheUrl("net_01J0", PACK, 7)).toBe(
      `https://pack-blocks.fyrden.invalid/v1/net_01J0/${PACK}/7`,
    );
    for (const scope of ["", "a/b", "../x", "a?b", "a%2f", "x".repeat(129)]) {
      expect(() => blockCacheUrl(scope, PACK, 0)).toThrow(RangeError);
    }
    expect(() => blockCacheUrl("net_a", "nope", 0)).toThrow(RangeError);
    expect(() => blockCacheUrl("net_a", PACK, -1)).toThrow(RangeError);
  });

  it("stores immutable, cacheable responses", async () => {
    const cache = await namedCache();
    await createCacheApiBlockCache({ cache }).put("net_a", PACK, 0, block(5, 10));
    const stored = await cache.match(blockCacheUrl("net_a", PACK, 0));
    expect(stored?.headers.get("cache-control")).toMatch(/immutable/);
    expect(stored?.headers.get("cache-control")).not.toMatch(/public/);
    expect(new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      block(5, 10),
    );
  });

  it("stops calling the Cache API when its per-request budget is spent", async () => {
    const cache = await namedCache();
    const tier = createCacheApiBlockCache({ cache, maxCalls: 3 });
    await tier.put("net_a", PACK, 0, block(1, 10));
    expect(await tier.get("net_a", PACK, 0)).toEqual(block(1, 10));
    expect(await tier.get("net_a", PACK, 1)).toBeUndefined();
    // Budget spent: a block that is cached now reads as a miss, and puts are dropped.
    expect(await tier.get("net_a", PACK, 0)).toBeUndefined();
    await tier.put("net_a", PACK, 2, block(2, 10));
    expect(tier.calls).toBe(3);
    expect(tier.skipped).toBe(2);
    expect(await cache.match(blockCacheUrl("net_a", PACK, 2))).toBeUndefined();
    // The next request gets a fresh budget.
    const next = createCacheApiBlockCache({ cache, maxCalls: 3 });
    expect(await next.get("net_a", PACK, 0)).toEqual(block(1, 10));
    expect(DEFAULT_CACHE_API_CALLS).toBeLessThan(50);
    expect(() => createCacheApiBlockCache({ cache, maxCalls: -1 })).toThrow(RangeError);
  });

  it("shares one call allowance across every tier made in an invocation, fetches included", async () => {
    // A cache that fails as the platform does once one invocation has made 50 calls.
    let made = 0;
    const store = await namedCache();
    const limited = {
      match(...args: Parameters<Cache["match"]>) {
        if (++made > 50) throw new Error("Too many subrequests by single Worker invocation.");
        return store.match(...args);
      },
      put(...args: Parameters<Cache["put"]>) {
        if (++made > 50) throw new Error("Too many subrequests by single Worker invocation.");
        return store.put(...args);
      },
    } as unknown as Cache;
    const metrics = createMetrics(createFakeDataset().dataset);
    const result = await measureInvocation(metrics, { where: "do", op: "alarm" }, async () => {
      countSubrequests("external", 5); // outbound fetches made earlier in the invocation
      // Two phases, each with a fresh tier of 40 calls: together they stay under 40.
      const parse = createCacheApiBlockCache({ cache: limited, maxCalls: 40 });
      for (let i = 0; i < 30; i++) await parse.get("net_a", PACK, i);
      const completion = createCacheApiBlockCache({ cache: limited, maxCalls: 40 });
      const misses: (Uint8Array | undefined)[] = [];
      for (let i = 0; i < 30; i++) misses.push(await completion.get("net_a", PACK, i));
      await completion.put("net_a", PACK, 0, block(1, 10));
      return { parse: parse.calls, completion: completion.calls, skipped: completion.skipped };
    });
    expect(made).toBe(35);
    expect(result).toEqual({ parse: 30, completion: 5, skipped: 26 });
  });

  it("treats a failing Cache API call as a miss, never as a failed read", async () => {
    const failing = {
      match: async () => {
        throw new Error("Too many subrequests by single Worker invocation.");
      },
      put: async () => {
        throw new Error("cache unavailable");
      },
    } as unknown as Cache;
    const tier = createCacheApiBlockCache({ cache: failing });
    expect(await tier.get("net_a", PACK, 0)).toBeUndefined();
    await expect(tier.put("net_a", PACK, 0, block(1, 10))).resolves.toBeUndefined();
    const tiered = createTieredBlockCache(createClockBlockCache(), tier);
    expect(await tiered.get("net_a", PACK, 1)).toBeUndefined();
  });
});

describe("memory then Cache API", () => {
  it("fills both tiers on put and copies a shared hit into memory", async () => {
    const shared = createCacheApiBlockCache({ cache: await namedCache() });
    const memoryA = createClockBlockCache();
    await createTieredBlockCache(memoryA, shared).put("net_a", PACK, 4, block(4, 50));
    expect(await memoryA.get("net_a", PACK, 4)).toEqual(block(4, 50));

    // Another isolate (empty memory) finds it in the shared tier and keeps a copy.
    const memoryB = createClockBlockCache();
    const tiered = createTieredBlockCache(memoryB, shared);
    expect(await tiered.get("net_a", PACK, 4)).toEqual(block(4, 50));
    expect(await memoryB.get("net_a", PACK, 4)).toEqual(block(4, 50));
    const callsBefore = shared.calls;
    expect(await tiered.get("net_a", PACK, 4)).toEqual(block(4, 50));
    expect(shared.calls).toBe(callsBefore);
  });

  it("is the memory tier alone when the Cache API tier is off", async () => {
    const memory = createClockBlockCache();
    const tiered = createTieredBlockCache(memory);
    await tiered.put("net_a", PACK, 0, block(9, 20));
    expect(await tiered.get("net_a", PACK, 0)).toEqual(block(9, 20));
    expect(await tiered.get("net_a", PACK, 1)).toBeUndefined();
  });
});
