import { createSha1Hasher, PackIdx, writeIdx } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { DO_MEMORY } from "../../src/git/memory-budget.js";
import { type HeldPackIndex, PackIndexCache } from "../../src/git/pack-index-cache.js";

/** An `.idx` of `count` entries: 1,072 + 28 × count bytes. */
async function idxOf(count: number): Promise<PackIdx> {
  const oids = new Uint8Array(count * 20);
  for (let i = 0; i < count; i++) {
    oids[i * 20] = i >> 8;
    oids[i * 20 + 1] = i & 0xff;
  }
  const written = await writeIdx(
    {
      count,
      oids,
      offsets: Float64Array.from({ length: count }, (_, i) => 12 + i * 30),
      crc32s: new Uint32Array(count),
    },
    new Uint8Array(20),
    { createHasher: () => createSha1Hasher({ detectCollisions: false }) },
  );
  return PackIdx.parse(written.bytes);
}

const bytesOf = (count: number) => 1072 + 28 * count;

/** A fanout: 1 KiB. */
const fanout = () => new Uint32Array(256);

/** Index loads that finish only when the test says, recording which ones started. */
class Loads {
  readonly started: string[] = [];
  readonly #open = new Map<string, PromiseWithResolvers<HeldPackIndex>>();

  /** Loads started and not finished. */
  get inFlight(): number {
    return this.#open.size;
  }

  of(packId: string): () => Promise<HeldPackIndex> {
    return () => {
      this.started.push(packId);
      const load = Promise.withResolvers<HeldPackIndex>();
      this.#open.set(packId, load);
      return load.promise;
    };
  }

  resolve(packId: string, held: HeldPackIndex): void {
    this.#take(packId).resolve(held);
  }

  reject(packId: string, error: Error): void {
    this.#take(packId).reject(error);
  }

  #take(packId: string): PromiseWithResolvers<HeldPackIndex> {
    const load = this.#open.get(packId);
    if (!load) throw new Error(`no load of ${packId} in flight`);
    this.#open.delete(packId);
    return load;
  }
}

describe("pack index cache", () => {
  it("is carved out of the object's fixed memory, beside the block cache", () => {
    expect(new PackIndexCache().maxBytes).toBe(DO_MEMORY.indexCacheBytes);
    expect(new PackIndexCache().maxWholeBytes).toBe(DO_MEMORY.indexCacheBytes / 4);
  });

  it("loads an index once and serves it from memory after", async () => {
    const cache = new PackIndexCache(64 * 1024);
    const idx = await idxOf(10);
    let loads = 0;
    const load = async () => {
      loads++;
      return idx;
    };
    expect(cache.get("p1")).toBeUndefined();
    // Two callers at once share one load.
    const [a, b] = await Promise.all([
      cache.load("p1", bytesOf(10), load),
      cache.load("p1", bytesOf(10), load),
    ]);
    expect(a).toBe(idx);
    expect(b).toBe(idx);
    expect(cache.get("p1")).toBe(idx);
    expect(await cache.load("p1", bytesOf(10), load)).toBe(idx);
    expect(loads).toBe(1);
    expect(cache.bytes).toBe(bytesOf(10));
  });

  it("never holds more than its bound, evicting the least recently used", async () => {
    // Room for four indexes of 100 entries (3,872 bytes each), not five.
    const cache = new PackIndexCache(4 * bytesOf(100) + 100);
    const idx = await idxOf(100);
    for (const id of ["a", "b", "c", "d"]) await cache.load(id, bytesOf(100), async () => idx);
    expect(cache.count).toBe(4);
    cache.get("a");
    await cache.load("e", bytesOf(100), async () => idx);
    expect(cache.bytes).toBe(4 * bytesOf(100));
    expect(cache.get("b")).toBeUndefined();
    for (const id of ["a", "c", "d", "e"]) expect(cache.get(id)).toBe(idx);
    // A fanout takes its 1 KiB: the oldest index makes room.
    await cache.load("f", 1024, async () => idx.fanout);
    expect(cache.bytes).toBe(3 * bytesOf(100) + 1024);
    // The reads above left "a" the least recently used.
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("f")).toBe(idx.fanout);
  });

  it("counts what a load returned at its real size", async () => {
    const small = await idxOf(10);
    const large = await idxOf(100);
    const cache = new PackIndexCache(4 * bytesOf(100) + 100);
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`);
    for (const id of ids) await cache.load(id, bytesOf(10), async () => small);
    expect(cache.bytes).toBe(11 * bytesOf(10));
    // Room is made for 10 entries (s0 goes); the index has 100, so s1 and s2 go too.
    expect(await cache.load("y", bytesOf(10), async () => large)).toBe(large);
    expect(cache.bytes).toBe(8 * bytesOf(10) + bytesOf(100));
    expect(cache.bytes).toBeLessThanOrEqual(cache.maxBytes);
    for (const id of ["s0", "s1", "s2"]) expect(cache.get(id)).toBeUndefined();
    expect(cache.get("s3")).toBe(small);
    expect(cache.get("y")).toBe(large);
  });

  it("does not keep a loaded index larger than it may hold", async () => {
    const large = await idxOf(100);
    const cache = new PackIndexCache(4 * bytesOf(10));
    expect(await cache.load("y", bytesOf(10), async () => large)).toBe(large);
    expect(cache.get("y")).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it("refuses to make room for more than a quarter of its bound", () => {
    const cache = new PackIndexCache(4096);
    expect(() => cache.load("big", 1025, async () => new Uint32Array(256))).toThrow(RangeError);
  });

  it("keeps no failed load, so the next caller tries again", async () => {
    const cache = new PackIndexCache(64 * 1024);
    await expect(
      cache.load("p", bytesOf(10), async () => {
        throw new Error("R2 is down");
      }),
    ).rejects.toThrow("R2 is down");
    expect(cache.count).toBe(0);
    expect(cache.bytes).toBe(0);
    const idx = await idxOf(10);
    expect(await cache.load("p", bytesOf(10), async () => idx)).toBe(idx);
  });

  it("drops the packs that left the repository", async () => {
    const cache = new PackIndexCache(64 * 1024);
    const idx = await idxOf(10);
    for (const id of ["live", "retired"]) await cache.load(id, bytesOf(10), async () => idx);
    cache.retain(new Set(["live", "new"]));
    expect(cache.get("retired")).toBeUndefined();
    expect(cache.get("live")).toBe(idx);
    expect(cache.count).toBe(1);
    expect(cache.bytes).toBe(bytesOf(10));
  });

  it("keeps loads waiting for room within its bound, never evicting one in flight", async () => {
    const cache = new PackIndexCache(4096);
    const loads = new Loads();
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const results = ids.map((id) => cache.load(id, 1024, loads.of(id)));
    // Room for four: the other six wait instead of evicting a load in flight.
    expect(loads.started).toEqual(["p0", "p1", "p2", "p3"]);
    expect(cache.bytes).toBe(4096);
    expect(cache.count).toBe(10);
    for (const [i, id] of ids.entries()) {
      const held = fanout();
      loads.resolve(id, held);
      expect(await results[i]).toBe(held);
      expect(loads.inFlight * 1024).toBeLessThanOrEqual(cache.bytes);
      expect(cache.bytes).toBeLessThanOrEqual(cache.maxBytes);
    }
    expect(loads.started).toEqual(ids);
    // Each settled load made room for a waiting one; the last four are held.
    expect(cache.bytes).toBe(4096);
    for (const id of ["p6", "p7", "p8", "p9"]) expect(cache.get(id)).toBeDefined();
    expect(cache.get("p5")).toBeUndefined();
  });

  it("shares a load in flight with a repeated lookup, even when out of room", async () => {
    const cache = new PackIndexCache(4096);
    const loads = new Loads();
    const first = ["a", "b", "c", "d", "e"].map((id) => cache.load(id, 1024, loads.of(id)));
    const again = cache.load("a", 1024, loads.of("a"));
    expect(loads.started).toEqual(["a", "b", "c", "d"]);
    const held = fanout();
    loads.resolve("a", held);
    expect(await first[0]).toBe(held);
    expect(await again).toBe(held);
    // "a" settling made room for "e"; nothing loaded "a" twice.
    expect(loads.started).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not keep a load larger than its room while others are in flight", async () => {
    const cache = new PackIndexCache(4096);
    const loads = new Loads();
    const small = cache.load("small", 512, loads.of("small"));
    for (const id of ["b", "c", "d"]) void cache.load(id, 1024, loads.of(id));
    void cache.load("e", 512, loads.of("e"));
    expect(cache.bytes).toBe(4096);
    // 1 KiB came back for 512 bytes of room, and the rest is set aside for the loads in flight.
    const held = fanout();
    loads.resolve("small", held);
    expect(await small).toBe(held);
    expect(cache.get("small")).toBeUndefined();
    expect(cache.bytes).toBe(3584);
    expect(cache.count).toBe(4);
    expect(loads.inFlight).toBe(4);
  });

  it("gives the room of a failed load to a load waiting for it", async () => {
    const cache = new PackIndexCache(4096);
    const loads = new Loads();
    const results = ["a", "b", "c", "d", "e"].map((id) => cache.load(id, 1024, loads.of(id)));
    expect(loads.started).toEqual(["a", "b", "c", "d"]);
    loads.reject("b", new Error("R2 is down"));
    await expect(results[1]).rejects.toThrow("R2 is down");
    expect(loads.started).toEqual(["a", "b", "c", "d", "e"]);
    expect(cache.bytes).toBe(4096);
    expect(cache.count).toBe(4);
  });

  it("counts the load of a pack that left the repository until it settles", async () => {
    const cache = new PackIndexCache(64 * 1024);
    const loads = new Loads();
    const first = cache.load("gone", 1024, loads.of("gone"));
    cache.retain(new Set(["live"]));
    expect(cache.bytes).toBe(1024);
    // A lookup while it loads still shares the load.
    const again = cache.load("gone", 1024, loads.of("gone"));
    expect(loads.started).toEqual(["gone"]);
    const held = fanout();
    loads.resolve("gone", held);
    expect(await first).toBe(held);
    expect(await again).toBe(held);
    expect(cache.get("gone")).toBeUndefined();
    expect(cache.bytes).toBe(0);
    expect(cache.count).toBe(0);
  });
});
