import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { alignFiles } from "../../src/blame/align.js";
import {
  type BlameState,
  decodeBlameState,
  encodeBlameState,
  liveStateBytes,
  MAX_STATE_BYTES,
} from "../../src/blame/state.js";
import { oidFromHex } from "../../src/object/oid.js";
import { IDX_FANOUT_ENTRIES, IDX_OIDS_START } from "../../src/pack/idx-format.js";
import { RangedPackIdx } from "../../src/pack/idx-range-read.js";
import { maxCompressedBytes } from "../../src/pack/inflate.js";
import type { BlockCache } from "../../src/ports/block-cache.js";
import type { PackId } from "../../src/ports/pack-store.js";
import type { Zlib } from "../../src/ports/zlib.js";
import { DeltaBaseCache } from "../../src/reader/delta-base-cache.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import { createPrepaidMemory } from "../../src/reader/prepaid-memory.js";
import type { ViewPack } from "../../src/reader/view.js";
import type { ReaderWork } from "../../src/reader/work.js";
import { createMemoryBlockCache } from "../../testing/fakes/memory-block-cache.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { buildPack, encodeDelta, gitOid, type PackEntrySpec } from "../pack/pack-builder.js";
import { prng } from "../pack/repo-fixture.js";

/*
 * What a blame read holds, against the figures its memory bound is built on,
 * on small generated packs. It collects garbage at each boundary, so it reads
 * what's reachable, and it runs only on request:
 *
 *   FYRDEN_BENCH=1 npx vitest run test/reader/blame-memory.bench.test.ts
 *
 * The boundaries: each store read, the join of its blocks, each inflate, the
 * collected chunks inside one, each charge to the work port, each put in the
 * delta-base cache. Node's zlib is the real adapter's; workerd's isn't this.
 */

const MiB = 1024 * 1024;
const KiB = 1024;
const CAP = 4 * MiB;
const CACHE = 8 * MiB;
const PAGE = 128 * KiB;
const PREPAID = 12 * MiB;

/** The figures under test, in bytes. */
const INPUT_BOUND = 3 * (maxCompressedBytes(CAP) + 128 * KiB);
const OUTPUT_BOUND = 2 * (CAP + 1) + 64 * KiB;
const SCRATCH_BOUND = INPUT_BOUND + OUTPUT_BOUND;
const APPLY_BOUND = CACHE + 2 * CAP;
const RETURNED_BOUND = CACHE + CAP;
/** Both files' bytes as keys, and offsets, ids, marks and the interning Map per line. */
const ALIGN_BOUND = 2 * MiB + 2 * 100_000 * 109;

/** Output buffers Node's zlib keeps alive between inflates; which, depends on its version. */
const NODE_ZLIB_BUFFERS = new Set([`inflate output ${64 * KiB + 64}`, `inflate output ${8 * KiB}`]);

const bench = process.env.FYRDEN_BENCH === "1";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const mib = (n: number) => (n / MiB).toFixed(2);

/** Reachable bytes above a baseline, at named moments. */
class Probe {
  #baseline = 0;
  /** Off while a fixture is built, and when the moment isn't of interest. */
  on = false;
  readonly peaks = new Map<string, number>();

  static reachable(): { buffers: number; heap: number } {
    // Twice: buffers found dead by the first are counted until their sweep has finished.
    gc();
    gc();
    const { arrayBuffers, heapUsed } = process.memoryUsage();
    return { buffers: arrayBuffers, heap: heapUsed };
  }

  start(): void {
    this.peaks.clear();
    this.#baseline = Probe.reachable().buffers;
    this.on = true;
  }

  stop(): void {
    this.on = false;
  }

  above(): number {
    return Probe.reachable().buffers - this.#baseline;
  }

  mark(name: string): void {
    if (!this.on) return;
    const live = this.above();
    if (live > (this.peaks.get(name) ?? Number.NEGATIVE_INFINITY)) this.peaks.set(name, live);
  }

  peak(...names: string[]): number {
    const known = names.length > 0 ? names : [...this.peaks.keys()];
    return Math.max(...known.map((name) => this.peaks.get(name) ?? 0));
  }

  report(title: string): void {
    const rows = [...this.peaks].map(([name, bytes]) => `${name} ${mib(bytes)}`).join(", ");
    console.log(`${title}: ${rows}`);
  }
}

const probe = new Probe();
const realConcat = Buffer.concat;
const realSet = Uint8Array.prototype.set;

/** A pack in memory, whose reads each hand out a new buffer, as an R2 body does. */
function storeOf(packs: Map<PackId, Uint8Array>) {
  const calls: number[] = [];
  return {
    calls,
    openRange: async (packId: PackId, offset: number, length: number) => {
      const bytes = packs.get(packId) as Uint8Array;
      const out = new Uint8Array(bytes.subarray(offset, offset + length));
      calls.push(length);
      probe.mark("run");
      return out;
    },
  };
}

function watchedZlib(): Zlib {
  const real = createNodeZlib();
  return {
    inflate(input, options) {
      probe.mark("before inflate");
      const out = real.inflate(input, options);
      probe.mark("after inflate");
      return out;
    },
    deflate: (input, options) => real.deflate(input, options),
  };
}

function watchedWork(): ReaderWork {
  return {
    charge(kind) {
      if (kind === "delta-result") probe.mark("before apply");
      if (kind === "exact-copy") probe.mark("before exact copy");
      if (kind === "returned-copy") probe.mark("returned");
    },
  };
}

/** A tier that copies out, like the real one, and drops what's put after copying it. */
function copyingTier(): BlockCache {
  return {
    get: async () => undefined,
    put: async (_scope, _pack, _index, block) => {
      void new Uint8Array(block);
    },
  };
}

function random(n: number, seed: number): Uint8Array {
  const rand = prng(seed);
  const out = new Uint8Array(n);
  // Whole words at a time: this is the slowest part of a fixture.
  const words = new Uint32Array(out.buffer, 0, n >>> 2);
  for (let i = 0; i < words.length; i++) words[i] = Math.floor(rand() * 0x100000000);
  for (let i = words.length * 4; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const stop = Math.min(i + 3800, data.length);
    for (; i < stop; i++) {
      a += data[i] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A valid zlib stream in stored blocks of `block` bytes: five bytes of framing each, so longer than its data. */
function storedStream(data: Uint8Array, block: number): Uint8Array {
  const blocks = Math.ceil(data.length / block);
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let start = 0; start < data.length; start += block) {
    const piece = data.subarray(start, start + block);
    out[at] = start + block >= data.length ? 1 : 0;
    view.setUint16(at + 1, piece.length, true);
    view.setUint16(at + 3, ~piece.length & 0xffff, true);
    out.set(piece, at + 5);
    at += 5 + piece.length;
  }
  view.setUint32(at, adler32(data));
  return out;
}

const packIdOf = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5FA${n}` as PackId;

/** A view pack over built bytes, its `.idx` answered from a list of where each oid is. */
function viewPackOf(n: number, bytes: Uint8Array, where: ReadonlyMap<string, number>): ViewPack {
  return {
    packId: packIdOf(n),
    bytes: bytes.length,
    idx: {
      lookup: async (oid) => {
        const offset = where.get(Buffer.from(oid).toString("hex"));
        return offset === undefined ? undefined : { position: 0, offset };
      },
      crc32At: async () => 0,
    },
  };
}

interface Opened {
  readonly reader: ObjectReader;
  readonly memory: ReturnType<typeof createPrepaidMemory>;
  readonly store: ReturnType<typeof storeOf>;
}

/** A reader configured as blame's is, over one built pack. */
async function blameReader(
  packs: readonly { bytes: Uint8Array; where: ReadonlyMap<string, number>; pack?: ViewPack }[],
  blockCache?: BlockCache,
): Promise<Opened> {
  const stored = new Map<PackId, Uint8Array>();
  const views = packs.map(({ bytes, where, pack }, n) => {
    stored.set(packIdOf(n), bytes);
    return pack ?? viewPackOf(n, bytes, where);
  });
  const store = storeOf(stored);
  const memory = createPrepaidMemory(PREPAID);
  const reader = await ObjectReader.open({
    view: { scope: "net-bench", packs: views },
    packStore: store,
    zlib: watchedZlib(),
    memory,
    ...(blockCache ? { blockCache } : {}),
    limits: { maxObjectBytes: CAP, deltaBaseCacheBytes: CACHE },
    strictDeltaCache: true,
    work: watchedWork(),
  });
  return { reader, memory, store };
}

function built(entries: readonly PackEntrySpec[], oids: readonly string[]) {
  const pack = buildPack(entries);
  const where = new Map(oids.map((oid, i) => [oid, pack.offsets[i] as number]));
  return { bytes: pack.bytes, where };
}

/** A state of the given shape, whose lines are told once each. */
function bigState(shape: {
  readonly pairs: number;
  readonly ranges: number;
  readonly facts: number;
  readonly commits?: number;
  readonly path?: readonly Uint8Array[];
}): BlameState {
  const oid = (k: number) => oidFromHex((k + 1).toString(16).padStart(40, "0"));
  const commits = shape.pairs > 0 ? (shape.commits ?? 1) : 0;
  const queue = Array.from({ length: commits }, (_, c) => {
    const size = Math.floor(shape.pairs / commits);
    const pairs = new Int32Array(2 * size);
    for (let k = 0; k < size; k++) {
      pairs[2 * k] = k;
      pairs[2 * k + 1] = c * size + k;
    }
    return { oid: oid(c), generation: 100_000 - c, level: 1, pairs };
  });
  const firstRange = commits * Math.floor(shape.pairs / Math.max(commits, 1));
  const ranges = new Int32Array(4 * shape.ranges);
  for (let k = 0; k < shape.ranges; k++) {
    ranges.set([firstRange + k, 1, k % Math.max(shape.facts, 1), k + 1], 4 * k);
  }
  const factOrder = Array.from({ length: shape.facts }, (_, k) => oid(1_000_000 + k));
  const facts = Object.fromEntries(
    factOrder.map((id) => [
      Buffer.from(id).toString("hex"),
      {
        summary: "fix a thing in the walk of many commits",
        name: "A Person",
        email: "person@example.test",
        date: "2026-01-01T00:00:00Z",
      },
    ]),
  );
  return {
    commit: oid(9_000_000),
    path: shape.path ?? [new TextEncoder().encode("src"), new TextEncoder().encode("file.ts")],
    lines: firstRange + shape.ranges,
    steps: 0,
    queue,
    ranges,
    rangeCount: shape.ranges,
    facts,
    factOrder,
    stateLimit: false,
  };
}

const oidBytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

/** `toEqual` takes seconds on 4 MiB. */
const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && Buffer.compare(a, b) === 0;

describe.skipIf(!bench)("blame memory, on generated packs", () => {
  beforeAll(() => {
    // The chunks an inflate has collected, and the buffer they're joined into.
    Buffer.concat = ((list: readonly Uint8Array[], total?: number) => {
      probe.mark("inflate chunks");
      const out = realConcat(list, total);
      probe.mark("inflate joined");
      return out;
    }) as typeof Buffer.concat;
    // A run's blocks being joined: the previous attempt, the run and the copy are all reachable.
    Uint8Array.prototype.set = function (this: Uint8Array, source, offset) {
      if (this.length > 256 * KiB) probe.mark("join");
      return realSet.call(this, source as ArrayLike<number>, offset);
    };
  });

  afterAll(() => {
    Buffer.concat = realConcat;
    Uint8Array.prototype.set = realSet;
  });

  afterEach(() => {
    probe.stop();
    vi.restoreAllMocks();
  });

  describe("one object at the cap", () => {
    const data = random(CAP, 11);
    const oid = gitOid("blob", data);
    const plain = built([{ kind: "blob", data }], [oid]);
    // The longest stream accepted: an eighth of framing on every byte.
    const stream = storedStream(data, 40);
    const padded = built([{ kind: "blob", data, compressed: stream }], [oid]);

    it("the fixture's stream needs the doubling steps, up to the longest accepted", () => {
      expect(stream.length).toBeGreaterThan(CAP + CAP / 8);
      expect(stream.length).toBeLessThanOrEqual(maxCompressedBytes(CAP));
    });

    for (const [title, fixture, tier] of [
      ["incompressible, no tier", plain, false],
      ["longest stream, no tier", padded, false],
      ["longest stream, a tier that copies", padded, true],
    ] as const) {
      it(`${title}: input and inflate within the scratch figures`, async () => {
        const { reader, store, memory } = await blameReader(
          [fixture],
          tier ? copyingTier() : undefined,
        );
        probe.start();
        const object = await reader.readObject(oidBytes(oid));
        probe.stop();
        expect(object?.bytes.length).toBe(CAP);
        expect(store.calls.length).toBeGreaterThanOrEqual(3);
        probe.report(title);
        // The cache holds at most the object itself here, so these are the decoder's own.
        expect(probe.peak("before inflate", "after inflate", "run", "join")).toBeLessThanOrEqual(
          SCRATCH_BOUND,
        );
        expect(probe.peak("join", "run")).toBeLessThanOrEqual(INPUT_BOUND);
        expect(probe.peak("inflate joined", "inflate chunks")).toBeGreaterThan(CAP);
        expect(probe.peak("inflate joined", "inflate chunks")).toBeLessThanOrEqual(
          INPUT_BOUND + OUTPUT_BOUND,
        );
        expect(memory.peak()).toBeLessThanOrEqual(PREPAID);
        reader.release();
      });
    }

    it("a warm read through the tier: blocks, their copies and the join", async () => {
      const tier = createMemoryBlockCache();
      const first = await blameReader([padded], tier);
      await first.reader.readObject(oidBytes(oid));
      first.reader.release();
      const { reader, store } = await blameReader([padded], tier);
      probe.start();
      await reader.readObject(oidBytes(oid));
      probe.stop();
      expect(store.calls).toEqual([]);
      probe.report("warm tier");
      expect(probe.peak("join")).toBeLessThanOrEqual(INPUT_BOUND);
      expect(probe.peak()).toBeLessThanOrEqual(SCRATCH_BOUND);
      reader.release();
    });
  });

  describe("delta chains at the cap", () => {
    const insertOnly = (base: Uint8Array, seed: number) => {
      // The largest program under the cap: literal bytes, 128 for each 127.
      const result = random(Math.floor((CAP - 16) * (127 / 128)), seed);
      return { result, delta: encodeDelta(base.length, result.length, [{ insert: result }]) };
    };

    it("a program at the cap on a base at the cap: apply within its row, prepaid within 12 MiB", async () => {
      const base = random(CAP, 21);
      const { result, delta } = insertOnly(base, 22);
      expect(delta.length).toBeLessThanOrEqual(CAP);
      expect(delta.length).toBeGreaterThan(CAP - 64 * KiB);
      const fixture = built(
        [
          { kind: "blob", data: base },
          { kind: "ofs", base: 0, delta },
        ],
        [gitOid("blob", base), gitOid("blob", result)],
      );
      const { reader, memory } = await blameReader([fixture]);
      const puts: number[] = [];
      vi.spyOn(DeltaBaseCache.prototype, "put").mockImplementation(function (
        this: DeltaBaseCache,
        ...args
      ) {
        probe.mark("put");
        puts.push(args[2].data.length);
        return DELTA_PUT.apply(this, args);
      });
      probe.start();
      const object = await reader.readObject(oidBytes(gitOid("blob", result)));
      probe.stop();
      expect(same(object?.bytes, result)).toBe(true);
      expect(puts).toEqual([CAP, result.length]);
      probe.report("program at the cap");
      expect(probe.peak("before apply", "put")).toBeLessThanOrEqual(APPLY_BOUND);
      expect(probe.peak("returned")).toBeLessThanOrEqual(RETURNED_BOUND);
      // A program over 1 MiB was reserved, on top of the cache: exactly its row, and no more.
      expect(memory.peak()).toBe(CACHE + delta.length);
      expect(memory.peak()).toBeLessThanOrEqual(PREPAID);
      expect(memory.held()).toBe(CACHE);
      reader.release();
      expect(memory.held()).toBe(0);
    }, 300_000);

    it("two objects of exactly the cap: the base stays through its apply, and they can't both stay", async () => {
      const base = random(CAP, 31);
      const result = new Uint8Array(CAP);
      result.set(base.subarray(1));
      result[CAP - 1] = (base[0] as number) ^ 1;
      const next = new Uint8Array(CAP);
      next.set(result.subarray(1));
      next[CAP - 1] = (result[0] as number) ^ 1;
      const program = (from: Uint8Array, to: Uint8Array) => {
        const ops: ({ copy: [number, number] } | { insert: Uint8Array })[] = [];
        for (let at = 1; at < CAP; at += 0x10000)
          ops.push({ copy: [at, Math.min(0x10000, CAP - at)] });
        ops.push({ insert: to.subarray(CAP - 1) });
        return encodeDelta(from.length, to.length, ops);
      };
      const fixture = built(
        [
          { kind: "blob", data: base },
          { kind: "ofs", base: 0, delta: program(base, result) },
          { kind: "ofs", base: 1, delta: program(result, next) },
        ],
        [gitOid("blob", base), gitOid("blob", result), gitOid("blob", next)],
      );
      const { reader, memory } = await blameReader([fixture]);
      const held: number[] = [];
      vi.spyOn(DeltaBaseCache.prototype, "put").mockImplementation(function (
        this: DeltaBaseCache,
        ...args
      ) {
        probe.mark("put");
        const kept = DELTA_PUT.apply(this, args);
        held.push(this.count);
        return kept;
      });
      probe.start();
      expect(same((await reader.readObject(oidBytes(gitOid("blob", next))))?.bytes, next)).toBe(
        true,
      );
      probe.stop();
      probe.report("two at the cap");
      expect(held).toEqual([1, 1, 1]);
      expect(probe.peak("before apply", "put")).toBeLessThanOrEqual(APPLY_BOUND);
      // Base, result and the program all reachable at the put: at least the two objects.
      expect(probe.peak("put")).toBeGreaterThanOrEqual(2 * CAP);
      expect(memory.peak()).toBe(CACHE);
      reader.release();
    }, 300_000);
  });

  describe("the delta-base cache's charge covers what it holds", () => {
    const SIZES = [1, 64, 1024, 4096, 16384, 21845, 32767, 32768, 32769, 65535, 65536, 65537];

    /** A pack of distinct compressible objects of one size, worth `factor` caches. */
    function ofSize(size: number, factor: number) {
      const count = Math.min(Math.ceil((factor * CACHE) / (size + 512)), 40_000);
      const entries: PackEntrySpec[] = [];
      const where = new Map<string, number>();
      const oids: Uint8Array[] = [];
      for (let k = 0; k < count; k++) {
        const data = new Uint8Array(size);
        new DataView(data.buffer).setUint8(0, k & 0xff);
        if (size >= 4) new DataView(data.buffer).setUint32(0, k);
        entries.push({ kind: "blob", data });
        const oid = new Uint8Array(20);
        new DataView(oid.buffer).setUint32(0, k);
        oids.push(oid);
      }
      const pack = buildPack(entries);
      entries.length = 0;
      oids.forEach((oid, k) => {
        where.set(Buffer.from(oid).toString("hex"), pack.offsets[k] as number);
      });
      return { bytes: pack.bytes, where, oids };
    }

    for (const size of SIZES) {
      it(`objects of ${size} bytes: retained after collection`, async () => {
        const fixture = ofSize(size, 1.25);
        const { reader } = await blameReader([fixture]);
        const before = Probe.reachable();
        // Quiet here: this reads thousands of objects, and each moment would collect.
        for (const oid of fixture.oids) await reader.readObject(oid);
        const after = Probe.reachable();
        const buffers = after.buffers - before.buffers;
        const total = buffers + after.heap - before.heap;
        console.log(
          `retained, ${size} bytes, ${fixture.oids.length} reads: buffers ${mib(buffers)}, with heap ${mib(total)}`,
        );
        // Buffers are the charge's to cover anywhere. With its heap, Node 26 held 7.54 MiB
        // at most and Node 24 held 10.67, so Node doesn't decide that: workerd does, through
        // `tools/bench/blame/run.ts --only=retention`, which held 8.01.
        expect(buffers).toBeLessThanOrEqual(CACHE + 64 * KiB);
        reader.release();
      });
    }

    it("churn: retention after collection, and the high-water with none forced", async () => {
      const fixture = ofSize(16 * KiB, 5);
      const { reader } = await blameReader([fixture]);
      const before = Probe.reachable();
      const beforeBoth = before.buffers + before.heap;
      let high = 0;
      for (let round = 0; round < 3; round++) {
        for (let k = 0; k < fixture.oids.length; k++) {
          await reader.readObject(fixture.oids[k] as Uint8Array);
          if (k % 16 === 0) {
            const { arrayBuffers, heapUsed } = process.memoryUsage();
            high = Math.max(high, arrayBuffers + heapUsed - beforeBoth);
          }
        }
      }
      const after = Probe.reachable();
      const retained = after.buffers + after.heap - beforeBoth;
      console.log(
        `churn, 3 x ${fixture.oids.length} reads of 16 KiB: retained ${mib(retained)}, high-water with no forced collection ${mib(high)}`,
      );
      expect(retained).toBeLessThanOrEqual(CACHE + 0.6 * MiB);
      reader.release();
    });
  });

  describe("a REF_DELTA chain across packs, through a ranged index", () => {
    /** An `.idx` of `entries` plus `padding` made-up ids in the bucket of the first, read by ranges. */
    function hostileIdx(entries: readonly { oid: string; offset: number }[], padding: number) {
      const first = oidBytes((entries[0] as { oid: string }).oid)[0] as number;
      const made = Array.from({ length: padding }, (_, k) => {
        const oid = new Uint8Array(20);
        oid[0] = first;
        oid[1] = (k >> 16) & 0xff;
        oid[2] = (k >> 8) & 0xff;
        oid[3] = k & 0xff;
        return { oid: Buffer.from(oid).toString("hex"), offset: 12 };
      });
      const all = [...entries, ...made].sort((a, b) => (a.oid < b.oid ? -1 : 1));
      const fanout = new Uint32Array(IDX_FANOUT_ENTRIES);
      for (const { oid } of all)
        fanout[oidBytes(oid)[0] as number] = (fanout[oidBytes(oid)[0] as number] as number) + 1;
      for (let b = 1; b < IDX_FANOUT_ENTRIES; b++)
        fanout[b] = (fanout[b] as number) + (fanout[b - 1] as number);
      const count = all.length;
      const oidsAt = IDX_OIDS_START;
      const offsetsAt = oidsAt + count * 24;
      const bytes = new Uint8Array(offsetsAt + count * 4);
      const view = new DataView(bytes.buffer);
      all.forEach(({ oid, offset }, position) => {
        bytes.set(oidBytes(oid), oidsAt + position * 20);
        view.setUint32(offsetsAt + position * 4, offset);
      });
      const reads: number[] = [];
      const idx = RangedPackIdx.withFanout(
        async (offset, length) => {
          reads.push(length);
          const out = new Uint8Array(bytes.subarray(offset, offset + length));
          probe.mark("index read");
          return out;
        },
        fanout,
        undefined,
        PAGE,
      );
      return { idx, reads };
    }

    it("the largest index read is one page, at every step of chain discovery", async () => {
      const base = random(CAP, 41);
      const result = new Uint8Array(CAP);
      result.set(base.subarray(0, CAP - 1));
      const baseOid = gitOid("blob", base);
      const resultOid = gitOid("blob", result);
      const ops = [];
      for (let at = 0; at < CAP - 1; at += 0x10000)
        ops.push({ copy: [at, Math.min(0x10000, CAP - 1 - at)] as [number, number] });
      ops.push({ insert: new Uint8Array(1) });
      const holder = buildPack([{ kind: "blob", data: base }]);
      const thin = buildPack([{ kind: "ref", baseOid, delta: encodeDelta(CAP, CAP, ops) }]);
      // 20 MiB of bucket on each, as a pusher can arrange.
      const padding = 1024 * 1024;
      const holderIdx = hostileIdx(
        [{ oid: baseOid, offset: holder.offsets[0] as number }],
        padding,
      );
      const thinIdx = hostileIdx([{ oid: resultOid, offset: thin.offsets[0] as number }], padding);
      const { reader } = await blameReader([
        {
          bytes: thin.bytes,
          where: new Map(),
          pack: { packId: packIdOf(0), bytes: thin.bytes.length, idx: thinIdx.idx },
        },
        {
          bytes: holder.bytes,
          where: new Map(),
          pack: { packId: packIdOf(1), bytes: holder.bytes.length, idx: holderIdx.idx },
        },
      ]);
      probe.start();
      const object = await reader.readObject(oidBytes(resultOid));
      probe.stop();
      expect(same(object?.bytes, result)).toBe(true);
      probe.report("ref delta across packs");
      expect(Math.max(...thinIdx.reads, ...holderIdx.reads)).toBeLessThanOrEqual(PAGE);
      expect(holderIdx.reads.length).toBeGreaterThan(2);
      expect(probe.peak()).toBeLessThanOrEqual(SCRATCH_BOUND + CACHE);
      reader.release();
    }, 300_000);
  });

  describe("between phases", () => {
    it("a read's temporaries are unreachable once it returns, and all but the copies after release", async () => {
      const a = random(MiB, 51);
      const b = new Uint8Array(a);
      b[17] = (a[17] as number) ^ 1;
      const tracked: { what: string; bytes: number; ref: WeakRef<ArrayBufferLike> }[] = [];
      const track = (what: string, bytes: Uint8Array) => {
        tracked.push({ what, bytes: bytes.buffer.byteLength, ref: new WeakRef(bytes.buffer) });
      };
      const real = createNodeZlib();
      const zlib: Zlib = {
        inflate(input, options) {
          track("inflate input", input);
          const out = real.inflate(input, options);
          track("inflate output", out.output);
          return out;
        },
        deflate: (input, options) => real.deflate(input, options),
      };
      const fixture = built(
        [
          { kind: "blob", data: a },
          {
            kind: "ofs",
            base: 0,
            delta: encodeDelta(a.length, b.length, [
              { copy: [0, 17] },
              { insert: b.subarray(17, 18) },
              { copy: [18, 0x10000 - 18] },
              ...Array.from({ length: 15 }, (_, k) => ({
                copy: [0x10000 * (k + 1), 0x10000] as [number, number],
              })),
            ]),
          },
        ],
        [gitOid("blob", a), gitOid("blob", b)],
      );
      const store = storeOf(new Map([[packIdOf(0), fixture.bytes]]));
      const memory = createPrepaidMemory(PREPAID);
      const reader = await ObjectReader.open({
        view: {
          scope: "net-bench",
          packs: [viewPackOf(0, fixture.bytes, fixture.where)],
        },
        packStore: {
          openRange: async (packId, offset, length) => {
            const out = await store.openRange(packId, offset, length);
            track("run", out);
            return out;
          },
        },
        zlib,
        memory,
        limits: { maxObjectBytes: CAP, deltaBaseCacheBytes: CACHE },
        strictDeltaCache: true,
      });
      // A WeakRef keeps its target until the job ends, and microtasks don't end one.
      const nextTask = () => new Promise((resolve) => setImmediate(resolve));
      const alive = () => {
        Probe.reachable();
        return tracked.flatMap(({ what, bytes, ref }) => (ref.deref() ? [`${what} ${bytes}`] : []));
      };

      await nextTask();
      probe.start();
      const object = await reader.readObject(oidBytes(gitOid("blob", b)));
      await nextTask();
      const reached = probe.above();
      probe.stop();
      expect(same(object?.bytes, b)).toBe(true);
      const afterRead = alive();
      console.log(
        `after a read of a 1 MiB delta on a 1 MiB base: ${mib(reached)} reachable; alive: ${afterRead.join(", ")}`,
      );
      // The base is cached, as the object zlib made when that's exact. No input, run or program,
      // but for Node's own zlib buffer of 64 KiB and a little, which it reuses.
      expect(afterRead.filter((row) => !NODE_ZLIB_BUFFERS.has(row))).toEqual([
        `inflate output ${MiB}`,
      ]);
      // Base and result in the cache, and the returned copy.
      expect(reached).toBeLessThanOrEqual(3 * MiB + 64 * KiB);

      reader.release();
      await nextTask();
      expect(alive().filter((row) => !NODE_ZLIB_BUFFERS.has(row))).toEqual([]);
      expect(memory.held()).toBe(0);
    });

    it("restore into read: a checkpoint's body is unreachable once decoded", async () => {
      const nextTask = () => new Promise((resolve) => setImmediate(resolve));
      const state = bigState({ pairs: 50_000, ranges: 25_000, facts: 2000 });
      let body: Uint8Array | undefined = encodeBlameState(state);
      expect(body.length).toBeLessThanOrEqual(MAX_STATE_BYTES);
      const ref = new WeakRef(body.buffer);
      const restored = decodeBlameState(body);
      body = undefined;
      await nextTask();
      Probe.reachable();
      expect(ref.deref()).toBeUndefined();
      expect(restored.lines).toBe(state.lines);
    });

    it("alignment into checkpoint: only the pairing is left, then the encoded bytes", async () => {
      const nextTask = () => new Promise((resolve) => setImmediate(resolve));
      const COUNT = 50_000;
      const text = (prefix: string) =>
        new TextEncoder().encode(
          Array.from({ length: COUNT }, (_, k) => `${prefix}${k}\n`).join(""),
        );
      const old = text("a");
      const next = text("a");
      next[10] = 98;
      await nextTask();
      const before = Probe.reachable();
      const result = alignFiles(old, next);
      await nextTask();
      const after = Probe.reachable();
      const left = after.buffers + after.heap - before.buffers - before.heap;
      console.log(`after an alignment of ${COUNT} lines: ${mib(left)} reachable`);
      // The pairing alone, four bytes a line, and a little that isn't this code's.
      expect(left).toBeLessThanOrEqual(COUNT * 4 + 256 * KiB);
      expect(result.kind).toBe("aligned");
    });
  });

  describe("what a state holds, against what it's charged", () => {
    for (const [title, shape] of [
      ["100,000 pairs on one commit", { pairs: 100_000, ranges: 0, facts: 0 }],
      [
        "100,000 lines across 5,000 commits",
        { pairs: 100_000, ranges: 0, facts: 0, commits: 5000 },
      ],
      ["100,000 settled ranges of one line", { pairs: 0, ranges: 100_000, facts: 1 }],
      ["40,000 commits of one line", { pairs: 40_000, ranges: 0, facts: 0, commits: 40_000 }],
      ["14,000 commits' facts", { pairs: 0, ranges: 14_000, facts: 14_000 }],
      [
        "12,000 commits of one line, and 88,000 settled ranges",
        { pairs: 12_000, ranges: 88_000, facts: 1, commits: 12_000 },
      ],
      [
        "12,000 commits of one line, and their facts",
        { pairs: 12_000, ranges: 12_000, facts: 12_000, commits: 12_000 },
      ],
      [
        "12,000 commits of one line, on a path of 64 long segments",
        {
          pairs: 12_000,
          ranges: 0,
          facts: 0,
          commits: 12_000,
          path: Array.from({ length: 64 }, () => new Uint8Array(255).fill(97)),
        },
      ],
      [
        "a path of 1,000 long segments",
        {
          pairs: 1,
          ranges: 0,
          facts: 0,
          path: Array.from({ length: 1000 }, () => new Uint8Array(255).fill(97)),
        },
      ],
      [
        "a path of 65,535 empty segments, as a forged checkpoint could say",
        {
          pairs: 1,
          ranges: 0,
          facts: 0,
          path: Array.from({ length: 65_535 }, () => new Uint8Array(0)),
        },
      ],
    ] as const) {
      it(`${title}: within its charge`, async () => {
        const nextTask = () => new Promise((resolve) => setImmediate(resolve));
        const encoded = encodeBlameState(bigState(shape));
        // One state against a settling heap gave 0.14 and 3.18 MiB for the same
        // shape, so warm the decoder, let the fixture go, and average copies.
        for (let k = 0; k < 3; k++) decodeBlameState(encoded, {});
        await nextTask();
        Probe.reachable();
        await nextTask();
        const before = Probe.reachable();
        const COPIES = 4;
        const states = Array.from({ length: COPIES }, () => decodeBlameState(encoded, {}));
        await nextTask();
        const after = Probe.reachable();
        const held = (after.buffers + after.heap - before.buffers - before.heap) / COPIES;
        const charged = liveStateBytes(states[0] as BlameState);
        console.log(`state, ${title}: holds ${mib(held)}, charged ${mib(charged)}`);
        expect(held).toBeLessThanOrEqual(charged);
      });
    }
  });

  describe("the largest legal alignment", () => {
    const COUNT = 100_000;
    // Ten bytes a line: the most lines 1 MiB holds under the line limit.
    const file = (prefix: string, edit: (k: number) => number) => {
      const out = new Uint8Array(COUNT * 10);
      const text = new TextEncoder();
      for (let k = 0; k < COUNT; k++) {
        text.encodeInto(`${prefix}${String(edit(k)).padStart(8, "0")}\n`, out.subarray(k * 10));
      }
      return out;
    };
    /** Heap and buffers, at every 20,000th interned line and at each later array's creation. */
    const peakDuring = (body: () => unknown) => {
      const base = Probe.reachable();
      let peak = 0;
      const mark = () => {
        const { buffers, heap } = Probe.reachable();
        peak = Math.max(peak, buffers + heap - base.buffers - base.heap);
      };
      let sets = 0;
      const realMapSet = Map.prototype.set;
      Map.prototype.set = function (this: Map<unknown, unknown>, key, value) {
        if (++sets % 20_000 === 0) mark();
        return realMapSet.call(this, key, value);
      };
      const realFill = Int32Array.prototype.fill;
      Int32Array.prototype.fill = function (this: Int32Array, ...args) {
        mark();
        return realFill.apply(this, args);
      };
      const realFrom = Int32Array.from;
      Int32Array.from = ((...args: Parameters<typeof Int32Array.from>) => {
        mark();
        return realFrom.apply(Int32Array, args);
      }) as typeof Int32Array.from;
      try {
        body();
      } finally {
        Map.prototype.set = realMapSet;
        Int32Array.prototype.fill = realFill;
        Int32Array.from = realFrom;
      }
      return peak;
    };

    for (const [title, old, next] of [
      ["no line in common, all interned twice", file("a", (k) => k), file("b", (k) => k)],
      [
        "one line changed in the middle",
        file("a", (k) => k),
        file("a", (k) => (k === 50_000 ? COUNT : k)),
      ],
      ["every line the same", file("a", () => 0), file("a", () => 0)],
    ] as const) {
      it(`${title}: arrays within their row`, () => {
        const peak = peakDuring(() => alignFiles(old, next));
        console.log(`alignment of 100,000 lines, ${title}: ${mib(peak)} reachable at its largest`);
        expect(peak).toBeLessThanOrEqual(ALIGN_BOUND);
      }, 300_000);
    }
  });
});

const DELTA_PUT = DeltaBaseCache.prototype.put;
