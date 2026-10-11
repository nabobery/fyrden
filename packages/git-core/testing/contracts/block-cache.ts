import { describe, expect, it } from "vitest";
import { BLOCK_SIZE, type BlockCache } from "../../src/ports/block-cache.js";
import { asPackId } from "../../src/ports/pack-store.js";
import { ViewSlicingBytes } from "./repo-store.js";

const PACK = asPackId("01J00000000000000000000000");
const OTHER_PACK = asPackId("01J00000000000000000000001");

/** The behaviour every `BlockCache` must have. `create` returns an empty cache. */
export function describeBlockCacheContract(name: string, create: () => Promise<BlockCache>): void {
  describe(`${name}: BlockCache contract`, () => {
    it("misses, then returns what was put", async () => {
      const cache = await create();
      expect(await cache.get("net-a", PACK, 0)).toBeUndefined();
      await cache.put("net-a", PACK, 0, Uint8Array.of(1, 2));
      expect(await cache.get("net-a", PACK, 0)).toEqual(Uint8Array.of(1, 2));
      expect(await cache.get("net-a", PACK, 1)).toBeUndefined();
    });

    it("keeps scopes and packs apart", async () => {
      const cache = await create();
      await cache.put("net-a", PACK, 0, Uint8Array.of(1));
      expect(await cache.get("net-b", PACK, 0)).toBeUndefined();
      await cache.put("net-a", OTHER_PACK, 0, Uint8Array.of(2));
      expect(await cache.get("net-a", PACK, 0)).toEqual(Uint8Array.of(1));
      expect(await cache.get("net-a", OTHER_PACK, 0)).toEqual(Uint8Array.of(2));
    });

    it("cannot be changed through what it was given or what it returned", async () => {
      const cache = await create();
      const block = ViewSlicingBytes.from([1, 2]);
      await cache.put("net-a", PACK, 0, block);
      block.fill(9);
      (await cache.get("net-a", PACK, 0))?.fill(7);
      expect(await cache.get("net-a", PACK, 0)).toEqual(Uint8Array.of(1, 2));
    });

    it("accepts a full block and refuses a larger one or a bad index", async () => {
      const cache = await create();
      await cache.put("net-a", PACK, 3, new Uint8Array(BLOCK_SIZE));
      expect((await cache.get("net-a", PACK, 3))?.length).toBe(BLOCK_SIZE);
      await expect(cache.put("net-a", PACK, 0, new Uint8Array(BLOCK_SIZE + 1))).rejects.toThrow(
        RangeError,
      );
      await expect(cache.put("net-a", PACK, -1, Uint8Array.of(1))).rejects.toThrow(RangeError);
      await expect(cache.get("net-a", PACK, 1.5)).rejects.toThrow(RangeError);
    });
  });
}
