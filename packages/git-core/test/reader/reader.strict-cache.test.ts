import { afterEach, describe, expect, it, vi } from "vitest";
import { PackError } from "../../src/pack/errors.js";
import type { Zlib } from "../../src/ports/zlib.js";
import { DeltaBaseCache } from "../../src/reader/delta-base-cache.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import type { RepoView } from "../../src/reader/view.js";
import { createReaderWorkMeter } from "../../src/reader/work.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { buildPack, gitOid, makeDelta, type PackEntrySpec, text } from "../pack/pack-builder.js";
import { loadPack, MiB, toOid } from "./support.js";

/*
 * A cached object can keep a buffer larger than itself alive: a runtime's
 * zlib may hand back a view of a bigger one, and small objects can share it.
 * In strict mode what's cached has a buffer of exactly its own length, and
 * each entry is charged enough for its own bookkeeping, so the cache's charge
 * covers what it holds. Off, nothing changes.
 */

/** Zlib whose outputs are views into buffers `slack` bytes larger, as some runtimes hand back. */
function slackZlib(slack: number): Zlib {
  const real = createNodeZlib();
  return {
    inflate(input, options) {
      const { output, consumed } = real.inflate(input, options);
      const roomy = new Uint8Array(output.length + slack);
      roomy.set(output);
      return { output: roomy.subarray(0, output.length), consumed };
    },
    deflate: (input, options) => real.deflate(input, options),
  };
}

async function open(entries: readonly PackEntrySpec[]) {
  const repo = createMemoryRepoStore();
  const pack = await loadPack(repo.packStore, buildPack(entries).bytes);
  const view: RepoView = { scope: "net-strict", packs: [pack] };
  return { view, store: repo.packStore };
}

const base = text("kept\n".repeat(40));
const tip = text(`${"kept\n".repeat(40)}more\n`);
const chain: PackEntrySpec[] = [
  { kind: "blob", data: base },
  { kind: "ofs", base: 0, delta: makeDelta(base, tip) },
];

afterEach(() => vi.restoreAllMocks());

describe("reader: strict delta-base cache", () => {
  it("caches exact buffers, and returns the object unchanged", async () => {
    const puts = vi.spyOn(DeltaBaseCache.prototype, "put");
    const { view, store } = await open(chain);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: slackZlib(4096),
      memory: createMemoryBudget(64 * MiB),
      strictDeltaCache: true,
    });
    expect((await reader.readObject(toOid(gitOid("blob", tip))))?.bytes).toEqual(tip);
    expect(puts).toHaveBeenCalledTimes(2);
    for (const call of puts.mock.calls) {
      const data = call[2].data;
      expect(data.buffer.byteLength).toBe(data.length);
      expect(data.byteOffset).toBe(0);
    }
    reader.release();
  });

  it("returns a copy of a cached object, so a caller's change doesn't reach the cache", async () => {
    const { view, store } = await open(chain);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: slackZlib(4096),
      memory: createMemoryBudget(64 * MiB),
      strictDeltaCache: true,
    });
    const oid = toOid(gitOid("blob", base));
    const first = await reader.readObject(oid);
    first?.bytes.fill(0);
    expect((await reader.readObject(oid))?.bytes).toEqual(base);
    reader.release();
  });

  it("charges an entry its length plus 512 bytes", async () => {
    const { view, store } = await open(chain);
    const created: DeltaBaseCache[] = [];
    const put = DeltaBaseCache.prototype.put;
    vi.spyOn(DeltaBaseCache.prototype, "put").mockImplementation(function (
      this: DeltaBaseCache,
      ...args
    ) {
      if (!created.includes(this)) created.push(this);
      return put.apply(this, args);
    });
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: createNodeZlib(),
      memory: createMemoryBudget(64 * MiB),
      strictDeltaCache: true,
    });
    await reader.readObject(toOid(gitOid("blob", tip)));
    expect(created).toHaveLength(1);
    expect(created[0]?.bytes).toBe(base.length + 512 + tip.length + 512);
    reader.release();
  });

  it("charges the copy to the work port, only when it copies", async () => {
    const { view, store } = await open([{ kind: "blob", data: base }]);
    const oid = toOid(gitOid("blob", base));
    const units = async (zlib: Zlib) => {
      const seen: number[] = [];
      const reader = await ObjectReader.open({
        view,
        packStore: store,
        zlib,
        memory: createMemoryBudget(64 * MiB),
        strictDeltaCache: true,
        work: {
          charge(kind, n) {
            if (kind === "exact-copy") seen.push(n);
          },
        },
      });
      await reader.readObject(oid);
      reader.release();
      return seen;
    };
    expect(await units(slackZlib(4096))).toEqual([base.length]);
    expect(await units(slackZlib(0))).toEqual([]);
  });

  it("refuses the copy without making it when work is spent", async () => {
    const { view, store } = await open([{ kind: "blob", data: base }]);
    const puts = vi.spyOn(DeltaBaseCache.prototype, "put");
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: slackZlib(4096),
      memory: createMemoryBudget(64 * MiB),
      strictDeltaCache: true,
      work: {
        charge(kind) {
          if (kind === "exact-copy") throw new Error("spent");
        },
      },
    });
    await expect(reader.readObject(toOid(gitOid("blob", base)))).rejects.toThrow("spent");
    expect(puts).not.toHaveBeenCalled();
    reader.release();
  });

  it("keeps the same behaviour when off: the view as zlib gave it, charged 64 bytes", async () => {
    const puts = vi.spyOn(DeltaBaseCache.prototype, "put");
    const { view, store } = await open([{ kind: "blob", data: base }]);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: slackZlib(4096),
      memory: createMemoryBudget(64 * MiB),
    });
    await reader.readObject(toOid(gitOid("blob", base)));
    expect(puts).toHaveBeenCalledTimes(1);
    const call = puts.mock.calls[0];
    expect(call?.[2].data.buffer.byteLength).toBe(base.length + 4096);
    expect((puts.mock.contexts[0] as DeltaBaseCache).bytes).toBe(base.length + 64);
    reader.release();
  });
});

describe("reader: a 4 MiB object cap", () => {
  const cap = 4 * MiB;
  const limits = { maxObjectBytes: cap, deltaBaseCacheBytes: 8 * MiB };
  const refused = async (entries: readonly PackEntrySpec[], oid: Uint8Array) => {
    const { view, store } = await open(entries);
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: createNodeZlib(),
      memory: createMemoryBudget(64 * MiB),
      limits,
    });
    const error = await reader.readObject(oid).catch((e: unknown) => e);
    reader.release();
    return error;
  };

  it("reads an object of exactly the cap, and refuses a byte over", async () => {
    const at = new Uint8Array(cap).fill(1);
    const over = new Uint8Array(cap + 1).fill(2);
    expect(await refused([{ kind: "blob", data: at }], toOid(gitOid("blob", at)))).toMatchObject({
      type: "blob",
    });
    const error = await refused([{ kind: "blob", data: over }], toOid(gitOid("blob", over)));
    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).code).toBe("object-too-large");
  });

  it("refuses a small object built on a base over the cap", async () => {
    const big = new Uint8Array(5 * MiB).fill(3);
    const small = big.subarray(0, 1024);
    const error = await refused(
      [
        { kind: "blob", data: big },
        { kind: "ofs", base: 0, delta: makeDelta(big, small) },
      ],
      toOid(gitOid("blob", small)),
    );
    expect((error as PackError).code).toBe("object-too-large");
  });

  it("refuses a delta whose result is over the cap", async () => {
    const small = text("small\n");
    const big = new Uint8Array(5 * MiB).fill(4);
    const error = await refused(
      [
        { kind: "blob", data: small },
        { kind: "ofs", base: 0, delta: makeDelta(small, big) },
      ],
      toOid(gitOid("blob", big)),
    );
    expect((error as PackError).code).toBe("object-too-large");
  });

  it("refuses before the work port pays for a body", async () => {
    const big = new Uint8Array(5 * MiB).fill(5);
    const { view, store } = await open([{ kind: "blob", data: big }]);
    const meter = createReaderWorkMeter({ limit: Number.MAX_SAFE_INTEGER });
    const spy = vi.spyOn(meter, "charge");
    const reader = await ObjectReader.open({
      view,
      packStore: store,
      zlib: createNodeZlib(),
      memory: createMemoryBudget(64 * MiB),
      limits,
      work: meter,
    });
    await expect(reader.readObject(toOid(gitOid("blob", big)))).rejects.toBeInstanceOf(PackError);
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("inflate");
    reader.release();
  });
});
