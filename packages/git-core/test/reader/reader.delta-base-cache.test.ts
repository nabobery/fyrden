import { beforeAll, describe, expect, it } from "vitest";
import type { Zlib } from "../../src/ports/zlib.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import { createReadStats } from "../../src/reader/stats.js";
import type { RepoView } from "../../src/reader/view.js";
import { createMemoryBlockCache } from "../../testing/fakes/memory-block-cache.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { buildPack, gitOid, makeDelta, type PackEntrySpec, text } from "../pack/pack-builder.js";
import { prng } from "../pack/repo-fixture.js";
import { countingPackStore, hex, loadPack, MiB, shuffled, toOid } from "./support.js";

/*
 * Invariant: reading 10k objects in depth-16 delta chains reads each base at
 * most once per request. The pack holds 589 chains of one whole blob and 16
 * deltas each (half OFS_DELTA, half REF_DELTA); every object is read once in
 * a random order. An entry is inflated each time its bytes are read, so a
 * zlib port that counts inflates counts entry reads: with the delta-base
 * cache, each of the 10,013 entries is inflated exactly once. With the
 * cache shrunk to almost nothing, the same reads inflate many times more,
 * which shows the count measures the cache.
 */

const CHAINS = 589;
const DEPTH = 16;

let pack: Uint8Array;
const expected = new Map<string, Uint8Array>();
beforeAll(() => {
  const rand = prng(16);
  const entries: PackEntrySpec[] = [];
  for (let c = 0; c < CHAINS; c++) {
    let data = text(`chain ${c}\n${"x".repeat(150 + Math.floor(rand() * 200))}\n`);
    const baseIndex = entries.length;
    entries.push({ kind: "blob", data });
    expected.set(gitOid("blob", data), data);
    for (let d = 1; d <= DEPTH; d++) {
      const next = new Uint8Array(data.length + 12);
      next.set(data);
      next.set(text(`line ${c}.${d}`.padEnd(11, ".")), data.length);
      next[next.length - 1] = 10;
      const delta = makeDelta(data, next);
      const prevIndex = baseIndex + d - 1;
      entries.push(
        c % 2 === 0
          ? { kind: "ofs", base: prevIndex, delta }
          : { kind: "ref", baseOid: gitOid("blob", data), delta },
      );
      data = next;
      expected.set(gitOid("blob", data), data);
    }
  }
  pack = buildPack(entries).bytes;
});

function countingZlib(): Zlib & { inflates: number } {
  const zlib = createNodeZlib();
  const counter = {
    inflates: 0,
    inflate(input: Uint8Array, options: { readonly maxOutput: number }) {
      counter.inflates++;
      return zlib.inflate(input, options);
    },
    deflate: zlib.deflate,
  };
  return counter;
}

async function readAll(deltaBaseCacheBytes?: number) {
  const repo = createMemoryRepoStore();
  const store = countingPackStore(repo.packStore);
  const viewPack = await loadPack(store, pack);
  const view: RepoView = { scope: "net-dbc", packs: [viewPack] };
  const zlib = countingZlib();
  const stats = createReadStats();
  const memory = createMemoryBudget(16 * MiB);
  const reader = await ObjectReader.open({
    view,
    packStore: store,
    zlib,
    memory,
    blockCache: createMemoryBlockCache(),
    stats,
    ...(deltaBaseCacheBytes ? { limits: { deltaBaseCacheBytes } } : {}),
  });
  // The cache's bytes are reserved for the whole operation.
  if (!deltaBaseCacheBytes) expect(memory.tryReserve(1)).toBeUndefined();
  try {
    for (const oid of shuffled([...expected.keys()], prng(5))) {
      const object = await reader.readObject(toOid(oid));
      expect(object?.type).toBe("blob");
      expect(hex(object?.bytes ?? new Uint8Array())).toBe(hex(expected.get(oid) as Uint8Array));
    }
  } finally {
    reader.release();
  }
  expect(memory.tryReserve(16 * MiB)).toBeDefined();
  return { inflates: zlib.inflates, stats, store };
}

describe("reader.delta-base-cache", () => {
  it("reads 10k objects in depth-16 chains reading each base at most once", async () => {
    expect(expected.size).toBe(CHAINS * (DEPTH + 1));
    const { inflates, stats, store } = await readAll();
    // One inflate per entry: no entry, base or not, was read twice.
    expect(inflates).toBe(expected.size);
    expect(stats.objectsRead).toBe(expected.size);
    expect(stats.deltaBaseHits).toBeGreaterThan(0);
    // With the block cache, each block came from the store once.
    expect(stats.storeBytes).toBeLessThanOrEqual(pack.length);
    expect(store.calls.reduce((n, c) => n + c.length, 0)).toBe(stats.storeBytes);
  }, 60_000);

  it("without room in the cache, bases are read again (the count measures the cache)", async () => {
    const { inflates } = await readAll(1024);
    expect(inflates).toBeGreaterThan(3 * expected.size);
  }, 60_000);
});
