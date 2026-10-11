import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { asPackId, type PackStore } from "../../src/ports/pack-store.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import { createReadStats } from "../../src/reader/stats.js";
import { createMemoryBlockCache } from "../../testing/fakes/memory-block-cache.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { entryHeader } from "../pack/pack-builder.js";
import { randomOids } from "../pack-index/support.js";
import { MiB, type RangeCall, spyBlockCache } from "./support.js";

/*
 * Invariant: a walk reads a pack in large sequential ranges, not 64 KiB
 * blocks, so a pass over 1 GiB costs about 128 reads. The pack here is
 * virtual: 1,024 entries of the same 1 MiB blob, stored deflated, generated
 * on demand by a counting pack store, so the test does not hold 1 GiB.
 * (The reader does not re-hash objects; the `.idx` gives each entry a
 * distinct oid.)
 */

const PACK_ID = asPackId("01J00000000000000000000SEQ");
const RANGE = 8 * MiB;

function virtualPack(entries: number, blobBytes: number) {
  const blob = new Uint8Array(blobBytes).map((_, i) => (i * 31) & 0xff);
  const body = deflateSync(blob, { level: 0 });
  const entry = new Uint8Array([...entryHeader(3, blobBytes), ...body]);
  const length = 12 + entries * entry.length + 20;
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(header.buffer).setUint32(8, entries);
  const byteAt = (pos: number): number => {
    if (pos < 12) return header[pos] as number;
    if (pos >= length - 20) return 0;
    return entry[(pos - 12) % entry.length] as number;
  };
  const calls: RangeCall[] = [];
  const store: PackStore = {
    listPacks: async () => [{ packId: PACK_ID, bytes: length }],
    beginPack: () => {
      throw new Error("read only");
    },
    async openRange(packId, offset, len) {
      calls.push({ packId, offset, length: len });
      if (offset < 0 || offset + len > length) throw new RangeError("outside the pack");
      const out = new Uint8Array(len);
      let pos = offset;
      let at = 0;
      while (at < len) {
        if (pos < 12 || pos >= length - 20) {
          out[at++] = byteAt(pos++);
          continue;
        }
        const within = (pos - 12) % entry.length;
        const take = Math.min(entry.length - within, len - at, length - 20 - pos);
        out.set(entry.subarray(within, within + take), at);
        at += take;
        pos += take;
      }
      return out;
    },
  };
  return { store, calls, length, entryLength: entry.length };
}

async function virtualIdx(entries: number, entryLength: number): Promise<PackIdx> {
  const oids = randomOids(entries, 8);
  const offsets = new Float64Array(entries).map((_, i) => 12 + i * entryLength);
  const written = await writeIdx(
    { count: entries, oids, offsets, crc32s: new Uint32Array(entries) },
    new Uint8Array(20),
    { createHasher: () => createSha1Hasher({ detectCollisions: false }) },
  );
  return PackIdx.parse(written.bytes);
}

describe("reader.sequential-range-reads", () => {
  it("walks a 1 GiB pack in ranges of at least 8 MiB, bypassing the block cache", async () => {
    const entries = 1024;
    const { store, calls, length, entryLength } = virtualPack(entries, MiB);
    expect(length).toBeGreaterThan(1024 * MiB);
    const idx = await virtualIdx(entries, entryLength);
    const blockCache = spyBlockCache(createMemoryBlockCache());
    const stats = createReadStats();
    const reader = await ObjectReader.open({
      view: { scope: "net-seq", packs: [{ packId: PACK_ID, bytes: length, idx }] },
      packStore: store,
      zlib: createNodeZlib(),
      memory: createMemoryBudget(96 * MiB),
      blockCache,
      stats,
    });
    let objects = 0;
    try {
      const oids = [...idx.entries()].map((e) => e.oid);
      await reader.walk(oids, ({ type, bytes }) => {
        objects++;
        expect(type).toBe("blob");
        expect(bytes.length).toBe(MiB);
      });
    } finally {
      reader.release();
    }
    expect(objects).toBe(entries);
    expect(blockCache.gets).toEqual([]);
    expect(blockCache.puts).toEqual([]);
    // At most 1 GiB / 8 MiB plus a small constant, each read but the last at least 8 MiB.
    expect(calls.length).toBeLessThanOrEqual(Math.ceil(length / RANGE) + 1);
    for (const call of calls.slice(0, -1)) expect(call.length).toBeGreaterThanOrEqual(RANGE);
    const total = calls.reduce((n, c) => n + c.length, 0);
    expect(total).toBeLessThanOrEqual(length);
    expect(stats.storeReads).toBe(calls.length);
    expect(stats.storeBytes).toBe(total);
    expect(stats.blockHits + stats.blockMisses).toBe(0);
  }, 120_000);

  it("the range size is configurable", async () => {
    const { store, calls, length, entryLength } = virtualPack(64, 64 * 1024);
    const idx = await virtualIdx(64, entryLength);
    const reader = await ObjectReader.open({
      view: { scope: "net-seq", packs: [{ packId: PACK_ID, bytes: length, idx }] },
      packStore: store,
      zlib: createNodeZlib(),
      memory: createMemoryBudget(96 * MiB),
      limits: { rangeBytes: MiB },
    });
    let objects = 0;
    try {
      await reader.walk(
        [...idx.entries()].map((e) => e.oid),
        () => {
          objects++;
        },
      );
    } finally {
      reader.release();
    }
    expect(objects).toBe(64);
    expect(calls.length).toBe(Math.ceil(length / MiB));
  });
});
