import { describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { OID_BYTES } from "../../src/object/oid.js";
import { PackError } from "../../src/pack/errors.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { BLOCK_SIZE, type BlockCache } from "../../src/ports/block-cache.js";
import type { PackStore } from "../../src/ports/pack-store.js";
import { MissingObjectError } from "../../src/reader/errors.js";
import { ObjectReader, type ObjectReaderOptions } from "../../src/reader/object-reader.js";
import { createReadStats } from "../../src/reader/stats.js";
import type { ViewPack } from "../../src/reader/view.js";
import { createMemoryBlockCache } from "../../testing/fakes/memory-block-cache.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import {
  buildPack,
  encodeDelta,
  gitOid,
  makeDelta,
  type PackEntrySpec,
  text,
} from "../pack/pack-builder.js";
import { prng } from "../pack/repo-fixture.js";
import { countingPackStore, hex, loadPack, MiB, spyBlockCache, toOid } from "./support.js";

/*
 * The reader's boundary (design: object authorization): it reads only the
 * packs of the view it was built from, keys every block by the view's scope,
 * and has no call that takes a pack id or a block index. Also covered here:
 * the block path (64 KiB aligned reads, a short last block, coalesced
 * misses, cache failures) and typed errors for bad packs.
 */

function randomBytes(length: number, seed: number): Uint8Array {
  const rand = prng(seed);
  return new Uint8Array(length).map(() => Math.floor(rand() * 256));
}

/** Stores a pack built by hand, with an `.idx` naming `oids[i]` at entry i (not parsed). */
async function rawPack(
  store: PackStore,
  entries: readonly PackEntrySpec[],
  oids: readonly string[],
  mutate?: (bytes: Uint8Array, offsets: number[]) => void,
): Promise<ViewPack> {
  const built = buildPack(entries);
  const bytes = built.bytes.slice();
  mutate?.(bytes, built.offsets);
  const packed = new Uint8Array(oids.length * OID_BYTES);
  oids.forEach((oid, i) => {
    packed.set(Buffer.from(oid, "hex"), i * OID_BYTES);
  });
  const written = await writeIdx(
    {
      count: oids.length,
      oids: packed,
      offsets: built.offsets,
      crc32s: new Uint32Array(oids.length),
    },
    new Uint8Array(20),
    { createHasher: () => createSha1Hasher({ detectCollisions: false }) },
  );
  const writer = store.beginPack();
  await writer.write(bytes);
  const info = await writer.finish();
  return { packId: info.packId, bytes: info.bytes, idx: PackIdx.parse(written.bytes) };
}

function open(
  options: Partial<ObjectReaderOptions> & Pick<ObjectReaderOptions, "view" | "packStore">,
) {
  return ObjectReader.open({
    zlib: createNodeZlib(),
    memory: createMemoryBudget(64 * MiB),
    ...options,
  });
}

const blobs = (seed: number, count: number, size: number) =>
  Array.from({ length: count }, (_, i) => randomBytes(size, seed * 100 + i));

describe("reader boundary: the view", () => {
  it("never reads a pack outside its view, and keys every block by the view's scope", async () => {
    const repo = createMemoryRepoStore();
    const store = countingPackStore(repo.packStore);
    const inView = blobs(1, 3, 1000);
    const outside = blobs(2, 3, 1000);
    const a = await loadPack(
      store,
      buildPack(inView.map((data) => ({ kind: "blob", data }))).bytes,
    );
    const b = await loadPack(
      store,
      buildPack(outside.map((data) => ({ kind: "blob", data }))).bytes,
    );
    const cache = spyBlockCache(createMemoryBlockCache());
    const reader = await open({
      view: { scope: "net-a", packs: [a] },
      packStore: store,
      blockCache: cache,
    });
    try {
      for (const data of outside) {
        const oid = toOid(gitOid("blob", data));
        expect(await reader.has(oid)).toBe(false);
        expect(await reader.readObject(oid)).toBeUndefined();
        expect(await reader.readHeader(oid)).toBeUndefined();
        await expect(reader.walk([oid], () => {})).rejects.toThrow(MissingObjectError);
      }
      for (const data of inView) {
        expect(
          hex((await reader.readObject(toOid(gitOid("blob", data))))?.bytes as Uint8Array),
        ).toBe(hex(data));
      }
    } finally {
      reader.release();
    }
    expect(store.calls.length).toBeGreaterThan(0);
    expect(store.calls.every((c) => c.packId === a.packId)).toBe(true);
    for (const [scope, packId] of [...cache.gets, ...cache.puts]) {
      expect(scope).toBe("net-a");
      expect(packId).toBe(a.packId);
    }
    expect(b.packId).not.toBe(a.packId);
  });

  it("refuses a malformed view", async () => {
    const { packStore } = createMemoryRepoStore();
    const pack = await loadPack(packStore, buildPack([{ kind: "blob", data: text("x") }]).bytes);
    const bad: unknown[] = [
      { scope: "", packs: [pack] },
      { scope: "net-a", packs: [{ ...pack, packId: "not-a-pack-id" }] },
      { scope: "net-a", packs: [pack, pack] },
      { scope: "net-a", packs: [{ ...pack, bytes: 31 }] },
      { scope: "net-a", packs: [{ ...pack, bytes: 1.5 }] },
    ];
    for (const view of bad) {
      await expect(open({ view: view as never, packStore })).rejects.toThrow(RangeError);
    }
  });

  it("cannot be used after release, and releases its memory once", async () => {
    const { packStore } = createMemoryRepoStore();
    const data = text("hello");
    const pack = await loadPack(packStore, buildPack([{ kind: "blob", data }]).bytes);
    const memory = createMemoryBudget(16 * MiB);
    const reader = await open({ view: { scope: "net-a", packs: [pack] }, packStore, memory });
    expect(memory.tryReserve(1)).toBeUndefined();
    reader.release();
    reader.release();
    expect(memory.tryReserve(16 * MiB)).toBeDefined();
    await expect(reader.readObject(toOid(gitOid("blob", data)))).rejects.toThrow(/released/);
  });
});

describe("reader block path", () => {
  it("reads 64 KiB aligned blocks, a short last block, and coalesces misses", async () => {
    const repo = createMemoryRepoStore();
    const store = countingPackStore(repo.packStore);
    const data = blobs(3, 4, 150_000);
    const pack = await loadPack(
      store,
      buildPack(data.map((d) => ({ kind: "blob", d, data: d }))).bytes,
    );
    expect(pack.bytes % BLOCK_SIZE).not.toBe(0);
    const stats = createReadStats();
    const reader = await open({
      view: { scope: "net-a", packs: [pack] },
      packStore: store,
      blockCache: createMemoryBlockCache(),
      stats,
    });
    try {
      for (const d of [...data].reverse()) {
        const before = store.calls.length;
        expect(hex((await reader.readObject(toOid(gitOid("blob", d))))?.bytes as Uint8Array)).toBe(
          hex(d),
        );
        // A 150 KB object spans three or four blocks: at most two store reads.
        expect(store.calls.length - before).toBeLessThanOrEqual(2);
      }
    } finally {
      reader.release();
    }
    for (const call of store.calls) {
      expect(call.offset % BLOCK_SIZE).toBe(0);
      const end = call.offset + call.length;
      expect(end === pack.bytes || end % BLOCK_SIZE === 0).toBe(true);
    }
    expect(store.calls.some((c) => c.offset + c.length === pack.bytes)).toBe(true);
    expect(stats.storeReads).toBe(store.calls.length);
    expect(stats.storeBytes).toBe(store.calls.reduce((n, c) => n + c.length, 0));
    expect(stats.blockMisses).toBe(Math.ceil(pack.bytes / BLOCK_SIZE));
    expect(stats.objectsRead).toBe(4);
  });

  it("works without a block cache", async () => {
    const { packStore } = createMemoryRepoStore();
    const data = text("no cache\n");
    const pack = await loadPack(packStore, buildPack([{ kind: "blob", data }]).bytes);
    const stats = createReadStats();
    const reader = await open({ view: { scope: "net-a", packs: [pack] }, packStore, stats });
    expect((await reader.readObject(toOid(gitOid("blob", data))))?.bytes).toEqual(data);
    reader.release();
    expect(stats.blockHits).toBe(0);
    expect(stats.blockMisses).toBe(1);
  });

  it("counts a failed cache put and still returns the object", async () => {
    const { packStore } = createMemoryRepoStore();
    const data = text("put fails\n");
    const pack = await loadPack(packStore, buildPack([{ kind: "blob", data }]).bytes);
    const failing: BlockCache = {
      get: async () => undefined,
      put: async () => {
        throw new Error("cache unavailable");
      },
    };
    const stats = createReadStats();
    const reader = await open({
      view: { scope: "net-a", packs: [pack] },
      packStore,
      blockCache: failing,
      stats,
    });
    expect((await reader.readObject(toOid(gitOid("blob", data))))?.bytes).toEqual(data);
    reader.release();
    expect(stats.cachePutErrors).toBe(1);
  });

  it("treats a cached block of the wrong length as a miss", async () => {
    const { packStore } = createMemoryRepoStore();
    const data = text("short block\n");
    const pack = await loadPack(packStore, buildPack([{ kind: "blob", data }]).bytes);
    const cache = createMemoryBlockCache();
    await cache.put("net-a", pack.packId, 0, new Uint8Array(5));
    const stats = createReadStats();
    const reader = await open({
      view: { scope: "net-a", packs: [pack] },
      packStore,
      blockCache: cache,
      stats,
    });
    expect((await reader.readObject(toOid(gitOid("blob", data))))?.bytes).toEqual(data);
    reader.release();
    expect(stats.blockMisses).toBe(1);
    expect((await cache.get("net-a", pack.packId, 0))?.length).toBe(pack.bytes);
  });

  it("returns bytes the caller owns", async () => {
    const { packStore } = createMemoryRepoStore();
    const base = text("base object\n".repeat(10));
    const target = text(`${"base object\n".repeat(10)}more\n`);
    const pack = await loadPack(
      packStore,
      buildPack([
        { kind: "blob", data: base },
        { kind: "ofs", base: 0, delta: makeDelta(base, target) },
      ]).bytes,
    );
    const reader = await open({ view: { scope: "net-a", packs: [pack] }, packStore });
    try {
      for (const data of [base, target, base, target]) {
        const oid = toOid(gitOid("blob", data));
        const first = await reader.readObject(oid);
        first?.bytes.fill(0);
        expect((await reader.readObject(oid))?.bytes).toEqual(data);
      }
    } finally {
      reader.release();
    }
  });
});

describe("reader errors", () => {
  it("a corrupt entry is a PackError", async () => {
    const { packStore } = createMemoryRepoStore();
    const data = randomBytes(500, 4);
    const oid = gitOid("blob", data);
    const pack = await rawPack(packStore, [{ kind: "blob", data }], [oid], (bytes, offsets) => {
      const at = (offsets[0] as number) + 10;
      bytes[at] = (bytes[at] as number) ^ 0xff;
    });
    const reader = await open({ view: { scope: "net-a", packs: [pack] }, packStore });
    await expect(reader.readObject(toOid(oid))).rejects.toThrow(PackError);
    await expect(reader.walk([toOid(oid)], () => {})).rejects.toThrow(PackError);
    reader.release();
  });

  it("a REF_DELTA whose base is not in the view is a missing-base PackError", async () => {
    const { packStore } = createMemoryRepoStore();
    const base = text("absent base\n");
    const target = text("absent base\nplus\n");
    const oid = gitOid("blob", target);
    const pack = await rawPack(
      packStore,
      [{ kind: "ref", baseOid: gitOid("blob", base), delta: makeDelta(base, target) }],
      [oid],
    );
    const reader = await open({ view: { scope: "net-a", packs: [pack] }, packStore });
    await expect(reader.readObject(toOid(oid))).rejects.toMatchObject({ code: "missing-base" });
    await expect(reader.readHeader(toOid(oid))).rejects.toMatchObject({ code: "missing-base" });
    reader.release();
  });

  it("a REF_DELTA cycle across packs stops at the depth cap", async () => {
    const { packStore } = createMemoryRepoStore();
    const x = "1".repeat(40);
    const y = "2".repeat(40);
    const delta = encodeDelta(4, 4, [{ copy: [0, 4] }]);
    const p1 = await rawPack(packStore, [{ kind: "ref", baseOid: y, delta }], [x]);
    const p2 = await rawPack(packStore, [{ kind: "ref", baseOid: x, delta }], [y]);
    const reader = await open({
      view: { scope: "net-a", packs: [p1, p2] },
      packStore,
      limits: { maxDeltaDepth: 10 },
    });
    await expect(reader.readObject(toOid(x))).rejects.toMatchObject({ code: "delta-too-deep" });
    await expect(reader.readHeader(toOid(x))).rejects.toMatchObject({ code: "delta-too-deep" });
    reader.release();
  });

  it("an object above the size cap is refused before inflating", async () => {
    const { packStore } = createMemoryRepoStore();
    const data = new Uint8Array(5000);
    const oid = gitOid("blob", data);
    const pack = await rawPack(packStore, [{ kind: "blob", data }], [oid]);
    const reader = await open({
      view: { scope: "net-a", packs: [pack] },
      packStore,
      limits: { maxObjectBytes: 4096 },
    });
    await expect(reader.readObject(toOid(oid))).rejects.toMatchObject({ code: "object-too-large" });
    reader.release();
  });

  it("an idx offset outside the pack is a PackError, not a wild read", async () => {
    const { packStore } = createMemoryRepoStore();
    const data = text("offset\n");
    const oid = gitOid("blob", data);
    const pack = await rawPack(packStore, [{ kind: "blob", data }], [oid]);
    const lying: ViewPack = {
      ...pack,
      idx: { lookup: () => ({ position: 0, offset: pack.bytes + 100, crc32: 0 }) },
    };
    const reader = await open({ view: { scope: "net-a", packs: [lying] }, packStore });
    await expect(reader.readObject(toOid(oid))).rejects.toThrow(PackError);
    reader.release();
  });

  it("refuses bad limits", async () => {
    const { packStore } = createMemoryRepoStore();
    const pack = await loadPack(packStore, buildPack([{ kind: "blob", data: text("x") }]).bytes);
    for (const limits of [{ rangeBytes: 0 }, { maxDeltaDepth: 0 }, { deltaBaseCacheBytes: -1 }]) {
      await expect(
        open({ view: { scope: "net-a", packs: [pack] }, packStore, limits }),
      ).rejects.toThrow(RangeError);
    }
  });
});

describe("prefetch", () => {
  /** A view pack whose `.idx` counts single and batched lookups. */
  function counted(pack: ViewPack, batched = true) {
    const counts = { lookup: 0, lookupMany: 0 };
    const idx = pack.idx;
    return {
      counts,
      pack: {
        ...pack,
        idx: {
          lookup: (oid: Uint8Array, at?: number) => {
            counts.lookup++;
            return idx.lookup(oid, at);
          },
          ...(batched && {
            lookupMany: (oids: readonly Uint8Array[]) => {
              counts.lookupMany++;
              return idx.lookupMany?.(oids) ?? [];
            },
          }),
        },
      } satisfies ViewPack,
    };
  }

  it("finds many objects with one batched lookup per pack, then reads them without lookups", async () => {
    const repo = createMemoryRepoStore();
    const first = blobs(3, 4, 300);
    const second = blobs(4, 4, 300);
    const a = counted(
      await loadPack(
        repo.packStore,
        buildPack(first.map((data) => ({ kind: "blob", data }))).bytes,
      ),
    );
    const b = counted(
      await loadPack(
        repo.packStore,
        buildPack(second.map((data) => ({ kind: "blob", data }))).bytes,
      ),
    );
    const reader = await open({
      view: { scope: "net", packs: [a.pack, b.pack] },
      packStore: repo.packStore,
    });
    try {
      const absent = toOid(gitOid("blob", new Uint8Array([1, 2, 3])));
      const all = [...first, ...second].map((data) => toOid(gitOid("blob", data)));
      await reader.prefetch([...all, absent]);
      expect([a.counts.lookupMany, b.counts.lookupMany]).toEqual([1, 1]);
      for (const [i, data] of [...first, ...second].entries())
        expect(hex((await reader.readObject(all[i] as never))?.bytes as Uint8Array)).toBe(
          hex(data),
        );
      expect(await reader.readObject(absent)).toBeUndefined();
      expect(a.counts.lookup + b.counts.lookup).toBe(0);
    } finally {
      reader.release();
    }
  });

  it("still finds a delta's base in the delta's own pack first", async () => {
    // The newer pack holds Y as a chain of three deltas; the older one holds
    // Y whole and X as a delta against it. With a depth limit of two, X reads
    // only through the older pack's copy of Y, as it does without prefetch.
    const repo = createMemoryRepoStore();
    const [z0, z1, z2, y, x] = blobs(6, 5, 400) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    const newer = await loadPack(
      repo.packStore,
      buildPack([
        { kind: "blob", data: z0 },
        { kind: "ofs", base: 0, delta: makeDelta(z0, z1) },
        { kind: "ofs", base: 1, delta: makeDelta(z1, z2) },
        { kind: "ofs", base: 2, delta: makeDelta(z2, y) },
      ]).bytes,
    );
    const yOid = gitOid("blob", y);
    const older = await loadPack(
      repo.packStore,
      buildPack([
        { kind: "blob", data: y },
        { kind: "ref", baseOid: yOid, delta: makeDelta(y, x) },
      ]).bytes,
    );
    const reader = await open({
      view: { scope: "net", packs: [newer, older] },
      packStore: repo.packStore,
      limits: { maxDeltaDepth: 2 },
    });
    try {
      const xOid = toOid(gitOid("blob", x));
      await reader.prefetch([xOid, toOid(yOid)]);
      expect(hex((await reader.readObject(xOid))?.bytes as Uint8Array)).toBe(hex(x));
    } finally {
      reader.release();
    }
  });

  it("leaves objects a pack without batched lookups may hold to the ordinary lookup", async () => {
    const repo = createMemoryRepoStore();
    const data = blobs(5, 2, 300);
    const plain = counted(
      await loadPack(repo.packStore, buildPack(data.map((d) => ({ kind: "blob", data: d }))).bytes),
      false,
    );
    const reader = await open({
      view: { scope: "net", packs: [plain.pack] },
      packStore: repo.packStore,
    });
    try {
      const oids = data.map((d) => toOid(gitOid("blob", d)));
      await reader.prefetch(oids);
      expect(hex((await reader.readObject(oids[0] as never))?.bytes as Uint8Array)).toBe(
        hex(data[0] as Uint8Array),
      );
      expect(plain.counts.lookup).toBeGreaterThan(0);
    } finally {
      reader.release();
    }
  });
});
