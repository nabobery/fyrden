import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { OID_BYTES } from "../../src/object/oid.js";
import { RangedPackIdx } from "../../src/pack/idx-range-read.js";
import type { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import { createReadStats } from "../../src/reader/stats.js";
import type { RepoView } from "../../src/reader/view.js";
import { createMemoryBlockCache } from "../../testing/fakes/memory-block-cache.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { buildRepo, prng } from "../pack/repo-fixture.js";
import { randomOids } from "../pack-index/support.js";
import {
  catFileBatch,
  countingPackStore,
  type GitObject,
  hex,
  idxOids,
  loadPack,
  MiB,
  type RangeCall,
  repackedPack,
  shuffled,
  toOid,
} from "./support.js";

/*
 * git is the oracle: a history packed by `git repack -adf --depth=50
 * --window=250` (long OFS_DELTA chains), stored through our parser and
 * `.idx` writer, must read back exactly as `git cat-file --batch` prints
 * every object: by random access, by header only, and by a pack-order walk.
 */

let sandbox: GitSandbox;
let expected: Map<string, GitObject>;
let packBytes: Uint8Array;
let maxDepth = 0;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await buildRepo(sandbox, { seed: 1505, commits: 80, files: 6, binaryBytes: 150_000 });
  packBytes = await repackedPack(sandbox);
  expected = await catFileBatch(sandbox);
  const verify = await sandbox.git(["verify-pack", "-s", ...(await packPath())]);
  for (const match of verify.stdout.matchAll(/chain length = (\d+)/g)) {
    maxDepth = Math.max(maxDepth, Number(match[1]));
  }
}, 60_000);
afterAll(() => sandbox.dispose());

async function packPath(): Promise<string[]> {
  const dir = join(sandbox.dir, ".git/objects/pack");
  return (await readdir(dir)).filter((n) => n.endsWith(".idx")).map((n) => join(dir, n));
}

async function setUp(options: { ranged?: boolean; rangeBytes?: number } = {}) {
  const repo = createMemoryRepoStore();
  const store = countingPackStore(repo.packStore);
  let pack = await loadPack(store, packBytes);
  if (options.ranged) {
    // The `.idx` read by ranges, as from R2: only the fanout is in memory.
    const idx = pack.idx as PackIdx;
    const written = await writeIdxBytes(idx);
    pack = {
      ...pack,
      idx: RangedPackIdx.withFanout(
        async (offset, length) => written.subarray(offset, offset + length),
        idx.fanout,
        written.length,
      ),
    };
  }
  const view: RepoView = { scope: "net-oracle", packs: [pack] };
  const blockCache = createMemoryBlockCache();
  const open = (stats = createReadStats()) =>
    ObjectReader.open({
      view,
      packStore: store,
      zlib: createNodeZlib(),
      memory: createMemoryBudget(64 * MiB),
      blockCache,
      stats,
      ...(options.rangeBytes ? { limits: { rangeBytes: options.rangeBytes } } : {}),
    });
  return { store, pack, open };
}

async function writeIdxBytes(idx: PackIdx): Promise<Uint8Array> {
  const count = idx.count;
  const oids = new Uint8Array(count * OID_BYTES);
  const offsets = new Float64Array(count);
  const crc32s = new Uint32Array(count);
  for (const e of idx.entries()) {
    oids.set(e.oid, e.position * OID_BYTES);
    offsets[e.position] = e.offset;
    crc32s[e.position] = e.crc32;
  }
  const written = await writeIdx({ count, oids, offsets, crc32s }, idx.packChecksum(), {
    createHasher: () => createSha1Hasher({ detectCollisions: false }),
  });
  return written.bytes;
}

describe("object reader against git cat-file", () => {
  it("the fixture has long delta chains", () => {
    expect(expected.size).toBeGreaterThan(300);
    expect(maxDepth).toBeGreaterThanOrEqual(16);
  });

  for (const ranged of [false, true]) {
    it(`readObject returns every object as git does (${ranged ? "ranged" : "in-memory"} idx)`, async () => {
      const { open } = await setUp({ ranged });
      const reader = await open();
      try {
        for (const oid of shuffled([...expected.keys()], prng(3))) {
          const object = await reader.readObject(toOid(oid));
          expect(object?.type, oid).toBe(expected.get(oid)?.type);
          expect(hex(object?.bytes ?? new Uint8Array()), oid).toBe(
            hex(expected.get(oid)?.bytes ?? new Uint8Array()),
          );
        }
      } finally {
        reader.release();
      }
    }, 60_000);
  }

  it("readHeader gives git's type and size for every object", async () => {
    const { open } = await setUp();
    const reader = await open();
    try {
      for (const [oid, object] of expected) {
        expect(await reader.readHeader(toOid(oid)), oid).toEqual({
          type: object.type,
          size: object.bytes.length,
        });
      }
    } finally {
      reader.release();
    }
  });

  it("has() knows every object and refuses absent ones without reading the pack", async () => {
    const { open, store } = await setUp();
    const reader = await open();
    try {
      for (const oid of expected.keys()) expect(await reader.has(toOid(oid))).toBe(true);
      const absent = randomOids(500, 77);
      for (let i = 0; i < 500; i++) {
        const oid = absent.subarray(i * OID_BYTES, (i + 1) * OID_BYTES);
        expect(await reader.has(oid)).toBe(false);
        expect(await reader.readObject(oid)).toBeUndefined();
        expect(await reader.readHeader(oid)).toBeUndefined();
      }
      expect(store.calls).toEqual([]);
    } finally {
      reader.release();
    }
  });

  it("walk yields every object once, in pack order, with contiguous large range reads", async () => {
    // A small range size so this pack needs many ranges and entries straddle them.
    const rangeBytes = 4096;
    const { open, store, pack } = await setUp({ rangeBytes });
    const reader = await open();
    const seen: string[] = [];
    const offsets: number[] = [];
    try {
      const oids = shuffled(idxOids(pack.idx as PackIdx), prng(9));
      await reader.walk(oids, ({ oid, type, bytes }) => {
        const key = hex(oid);
        seen.push(key);
        offsets.push((pack.idx as PackIdx).lookup(oid)?.offset as number);
        expect(type, key).toBe(expected.get(key)?.type);
        expect(hex(bytes), key).toBe(hex(expected.get(key)?.bytes as Uint8Array));
      });
    } finally {
      reader.release();
    }
    expect(new Set(seen).size).toBe(expected.size);
    expect(seen.length).toBe(expected.size);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    // The walk's own reads are contiguous and at least rangeBytes, except the last.
    // The walk's own reads form one contiguous chain from the first entry to
    // the end of the pack, each at least rangeBytes long except the last.
    const chain = [store.calls.find((c) => c.offset === 12) as RangeCall];
    for (;;) {
      const prev = chain[chain.length - 1] as RangeCall;
      const next = store.calls.find((c) => c.offset === prev.offset + prev.length);
      if (!next) break;
      chain.push(next);
    }
    const last = chain[chain.length - 1] as RangeCall;
    expect(last.offset + last.length).toBe(packBytes.length);
    // An entry larger than the range is read whole, so some reads are longer.
    expect(chain.length).toBeGreaterThan(1);
    expect(chain.length).toBeLessThanOrEqual(Math.ceil((packBytes.length - 12) / rangeBytes));
    for (const call of chain.slice(0, -1)) expect(call.length).toBeGreaterThanOrEqual(rangeBytes);
  }, 60_000);

  it("a second reader sharing the block cache reads nothing from the store", async () => {
    const { open, store } = await setUp();
    const first = await open();
    const sample = [...expected.keys()].filter((_, i) => i % 7 === 0);
    for (const oid of sample) await first.readObject(toOid(oid));
    first.release();
    const before = store.calls.length;
    const stats = createReadStats();
    const second = await open(stats);
    for (const oid of sample) await second.readObject(toOid(oid));
    second.release();
    expect(store.calls.length).toBe(before);
    expect(stats.blockMisses).toBe(0);
    expect(stats.blockHits).toBeGreaterThan(0);
    expect(stats.storeReads).toBe(0);
    expect(stats.objectsRead).toBe(sample.length);
  });
});
