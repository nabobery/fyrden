/**
 * The benchmark's Worker, run by workerd. `GET /case?name=` runs one primitive
 * repeatedly until it has taken long enough to read, and answers its time and
 * its counted units. `GET /memory?name=` runs a memory case, which the driver
 * watches from outside.
 *
 * Local workerd advances `performance.now()` during synchronous work, at 1 ms
 * resolution (measured for the code-rendering benchmark); deployed Workers
 * freeze it until I/O, so a run timed from inside is local only. `&runs=N` runs
 * a primitive exactly N times after its warm-up without reading the clock, for
 * timing from outside: with `runs=0` it gives the cost of the setup to subtract.
 * `BlameBench` is the same Worker as a Durable Object.
 */
import { createClockBlockCache } from "../../../../packages/adapters-cloudflare/src/cache/clock-block-cache.ts";
import { createWorkersZlib } from "../../../../packages/adapters-cloudflare/src/zlib/node-zlib.ts";
import { alignFiles } from "../../../../packages/git-core/src/blame/align.ts";
import {
  decodeBlameState,
  encodeBlameState,
} from "../../../../packages/git-core/src/blame/state.ts";
import { treeEntries } from "../../../../packages/git-core/src/object/tree.ts";
import { applyDelta } from "../../../../packages/git-core/src/pack/delta-apply.ts";
import { inflateEntry, NeedMoreInput } from "../../../../packages/git-core/src/pack/inflate.ts";
import { BlockReader } from "../../../../packages/git-core/src/reader/block-reader.ts";
import { ObjectReader } from "../../../../packages/git-core/src/reader/object-reader.ts";
import { createPrepaidMemory } from "../../../../packages/git-core/src/reader/prepaid-memory.ts";
import { createReadStats } from "../../../../packages/git-core/src/reader/stats.ts";
import type { ViewPack } from "../../../../packages/git-core/src/reader/view.ts";
import {
  buildPack,
  encodeDelta,
  type PackEntrySpec,
} from "../../../../packages/git-core/test/pack/pack-builder.ts";

const MiB = 1024 * 1024;
const KiB = 1024;
const CAP = 4 * MiB;
const CACHE = 8 * MiB;
const zlib = createWorkersZlib();
const PACK_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0" as never;

function random(n: number, seed: number): Uint8Array<ArrayBuffer> {
  let state = seed >>> 0 || 1;
  const out = new Uint8Array(n);
  const words = new Uint32Array(out.buffer, 0, n >>> 2);
  for (let i = 0; i < words.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    words[i] = state >>> 0;
  }
  return out;
}

function wordsOf(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = 97 + ((i * 2654435761) >>> 28);
  return out;
}

interface Timed {
  readonly ms: number;
  readonly runs: number;
}

/** Set by `&runs=N`, for one request. */
let fixedRuns: number | undefined;

/** Runs `body` until at least `minMs` passed, after one discarded warm-up. */
async function timed(body: () => unknown, minMs = 300): Promise<Timed> {
  await body();
  if (fixedRuns !== undefined) {
    for (let run = 0; run < fixedRuns; run++) await body();
    return { ms: 0, runs: fixedRuns };
  }
  // biome-ignore lint/suspicious/noExplicitAny: workerd global
  const clock = (globalThis as any).performance;
  const start = clock.now();
  let runs = 0;
  let ms = 0;
  do {
    await body();
    runs++;
    ms = clock.now() - start;
  } while (ms < minMs && runs < 100_000);
  return { ms, runs };
}

function reader(entries: readonly PackEntrySpec[], where: Map<string, number>, tier = false) {
  const { bytes } = buildPack(entries);
  const pack: ViewPack = {
    packId: PACK_ID,
    bytes: bytes.length,
    idx: {
      lookup: async (oid) => {
        const offset = where.get(hex(oid));
        return offset === undefined ? undefined : { position: 0, offset };
      },
      crc32At: async () => 0,
    },
  };
  return ObjectReader.open({
    view: { scope: "net-bench", packs: [pack] },
    packStore: {
      openRange: async (_id, offset, length) =>
        new Uint8Array(bytes.subarray(offset, offset + length)),
    },
    zlib,
    memory: createPrepaidMemory(12 * MiB),
    ...(tier ? { blockCache: createClockBlockCache() } : {}),
    limits: { maxObjectBytes: CAP, deltaBaseCacheBytes: CACHE },
    strictDeltaCache: true,
  });
}

function hex(oid: Uint8Array): string {
  let out = "";
  for (const byte of oid) out += byte.toString(16).padStart(2, "0");
  return out;
}

function oidOf(k: number): Uint8Array {
  const oid = new Uint8Array(20);
  new DataView(oid.buffer).setUint32(0, k + 1);
  return oid;
}

/** A pack and where its entries are, by the made-up ids `oidOf`. */
function indexed(entries: readonly PackEntrySpec[]) {
  const { offsets } = buildPack(entries);
  return new Map(entries.map((_, k) => [hex(oidOf(k)), offsets[k] as number]));
}

/** A tree in git's format, with `count` entries named by number. */
function treeBytes(count: number, oidAt: (k: number) => Uint8Array, mode = "100644"): Uint8Array {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (let k = 0; k < count; k++) {
    parts.push(encoder.encode(`${mode} file-${String(k).padStart(8, "0")}.ts\0`), oidAt(k));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

type Case = () => Promise<Record<string, unknown>>;

const encoder = new TextEncoder();
const textOf = (lines: readonly string[]) => encoder.encode(`${lines.join("\n")}\n`);
const setupUnits = (old: Uint8Array, new_: Uint8Array, lines: number) =>
  (old.length + new_.length) / 8 + lines;

/** Reports time against the counted work: what `alignFiles` counted, plus setup's charge. */
async function alignCase(old: Uint8Array, new_: Uint8Array, lines: number) {
  const first = alignFiles(old, new_);
  const units = first.work + setupUnits(old, new_, lines);
  const t = await timed(() => alignFiles(old, new_), 200);
  return {
    ...t,
    units,
    msPerRun: t.ms / t.runs,
    nsPerUnit: (t.ms / t.runs / units) * 1e6,
    kind: first.kind,
  };
}

/** Half the lines pending on one commit, half settled in ranges of one line, under 2 MiB. */
function stateOf(lines: number) {
  const half = lines >> 1;
  const pairs = new Int32Array(lines & ~1);
  for (let k = 0; k < half; k++) {
    pairs[2 * k] = k;
    pairs[2 * k + 1] = k;
  }
  const ranges = new Int32Array(4 * (lines - half));
  for (let k = 0; k < lines - half; k++) ranges.set([half + k, 1, 0, k + 1], 4 * k);
  const fact = oidOf(5);
  return {
    commit: oidOf(0) as never,
    path: [encoder.encode("f")],
    lines,
    steps: 0,
    queue: [{ oid: oidOf(1) as never, generation: 2, level: 2, pairs }],
    ranges,
    rangeCount: lines - half,
    facts: { [hex(fact)]: { summary: "s", name: "n", email: "e", date: "d" } },
    factOrder: [fact as never],
    stateLimit: false,
  };
}

/**
 * A delta program of one-byte copies, written straight to bytes. Built through
 * `encodeDelta`, 2 million opcodes held over 255 MiB of heap in setup alone,
 * more than the primitive being timed ever does.
 */
function copiesOfOneByte(baseSize: number, count: number, offsetOf: (k: number) => number) {
  const header = encodeDelta(baseSize, count, []);
  const out = new Uint8Array(header.length + 5 * count);
  out.set(header);
  let at = header.length;
  for (let k = 0; k < count; k++) {
    const offset = offsetOf(k);
    const opcode = at++;
    let command = 0x90;
    for (let byte = 0; byte < 3; byte++) {
      const value = (offset >> (8 * byte)) & 0xff;
      if (value !== 0) {
        command |= 1 << byte;
        out[at++] = value;
      }
    }
    out[opcode] = command;
    out[at++] = 1;
  }
  return out.subarray(0, at);
}

const ALIGN_CASES: Record<string, Case> = {
  async "align: nearly single-line 1 MiB pair"() {
    const old = new Uint8Array(MiB).fill(97);
    const new_ = new Uint8Array(MiB).fill(97);
    new_[MiB - 1] = 98;
    return alignCase(old, new_, 2);
  },
  async "align: 100,000 lines, identical but the middle"() {
    const make = (edit: number) =>
      textOf(
        Array.from(
          { length: 100_000 },
          (_, k) => `a${String(k === 50_000 ? edit : k).padStart(8, "0")}`,
        ),
      );
    return alignCase(make(1), make(2), 200_000);
  },
  async "align: 100,000 lines, no line in common"() {
    const make = (p: string) =>
      textOf(Array.from({ length: 100_000 }, (_, k) => `${p}${String(k).padStart(8, "0")}`));
    return alignCase(make("a"), make("b"), 200_000);
  },
  async "align: 100,000 lines, every one crowded"() {
    // Two words, so each line of each side is crowded, and the search has them to itself.
    let s = 7;
    const word = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return (s >> 16) & 1 ? "aaaaaaaaa" : "bbbbbbbbb";
    };
    const make = () => textOf(Array.from({ length: 50_000 }, () => word()));
    return alignCase(make(), make(), 100_000);
  },
  async "align: 100,000 lines of two bytes, every one crowded"() {
    // The shortest lines a file can have, so the classes dominate what's counted.
    const parent = "x\n".repeat(99_998);
    return alignCase(encoder.encode(`a\n${parent}b\n`), encoder.encode(parent), 200_000);
  },
  async "align: 100,000 short lines, crowded and gone in turn"() {
    // Every crowded line has gone lines to count both ways, as far as it looks.
    const old = textOf(Array.from({ length: 100_000 }, (_, k) => (k % 2 === 0 ? "x" : `${k}`)));
    return alignCase(old, encoder.encode("x\n".repeat(50_000)), 150_000);
  },
  async "align: 100,000 short lines, kept lines cutting up the crowded"() {
    // Stretches of 3 between kept lines: the most stretches a file can hold.
    const old = textOf(
      Array.from({ length: 100_000 }, (_, k) =>
        k % 4 === 0 ? `k${k}` : k % 4 === 2 ? `g${k}` : "x",
      ),
    );
    const new_ = textOf(
      Array.from({ length: 100_000 }, (_, k) =>
        k % 4 === 0 ? `k${k}` : k % 4 === 2 ? `h${k}` : "x",
      ),
    );
    return alignCase(old, new_, 200_000);
  },
  async "scoring: one line of a mebibyte of spaces, scanned once"() {
    // An indentation scan at the file limit. It is charged after its work, but stops at 201
    // bytes and refuses, so this line costs setup's passes, not a mebibyte of scanning.
    const wide = `${" ".repeat(MiB - 16)}y`;
    return alignCase(textOf(["a", wide, "a", "b"]), textOf(["a", "b"]), 6);
  },
  async "scoring: blank runs at the limit each way, cached"() {
    // A split looks up to 20 blank lines each way, charged one unit once they're cached.
    const unit = ["a", ...Array.from({ length: 21 }, () => "")];
    const old = Array.from({ length: 22_000 }, (_, k) => unit[k % 22] as string);
    const new_ = [...old.slice(0, 11_000), ...unit, ...old.slice(11_000)];
    return alignCase(textOf(old), textOf(new_), 44_000);
  },
  async "align: a search spending its whole work, in short rounds"() {
    // Moved blocks: long matches followed many times over, on few diagonals.
    const block = Array.from({ length: 200 }, (_, k) => `line${k}`);
    const lines = Array.from({ length: 400 }, (_, k) => block[k % 200] as string);
    const shifted = [...lines.slice(100), ...lines.slice(0, 100)];
    return alignCase(
      textOf(lines.concat(lines, lines)),
      textOf(shifted.concat(lines, shifted)),
      7200,
    );
  },
  async "align: 255 rounds over 100,000 lines"() {
    const unique = Array.from({ length: 49_000 }, (_, k) => `u${k}`);
    const swap = [...unique];
    for (let k = 0; k < 120; k++) {
      const at = 200 * k + 7;
      [swap[at], swap[at + 100]] = [swap[at + 100] as string, swap[at] as string];
    }
    return alignCase(textOf(unique), textOf(swap), 98_000);
  },
  async "scoring: 100-candidate groups, many"() {
    const unit = ["a", "", "  b", "", "c", ""];
    const old = Array.from({ length: 12_000 }, (_, k) => unit[k % 6] as string);
    const new_ = [...old.slice(0, 6000), ...unit, ...old.slice(6000)];
    return alignCase(textOf(old), textOf(new_), 24_000);
  },
  async "state: encode, 2 MiB of pairs and ranges"() {
    const state = stateOf(100_000);
    return per(await timed(() => encodeBlameState(state)), encodeBlameState(state).length);
  },
  async "state: decode and check, 2 MiB of pairs and ranges"() {
    const encoded = encodeBlameState(stateOf(100_000));
    return per(await timed(() => decodeBlameState(encoded)), encoded.length);
  },
  async "pairs: moving 100,000 pending pairs, per pair"() {
    const pairs = new Int32Array(200_000);
    const map = new Int32Array(100_000);
    for (let k = 0; k < 100_000; k++) map[k] = k;
    const t = await timed(() => {
      const moved = new Int32Array(200_000);
      for (let k = 0; k < 200_000; k += 2) {
        moved[k] = map[pairs[k] as number] as number;
        moved[k + 1] = pairs[k + 1] as number;
      }
      return moved;
    });
    return per(t, 100_000);
  },
};

const per = (t: Timed, units: number) => ({
  ...t,
  units,
  msPerRun: t.ms / t.runs,
  nsPerUnit: (t.ms / t.runs / units) * 1e6,
});

const CASES: Record<string, Case> = {
  async "inflate: incompressible at the cap"() {
    const data = random(CAP, 1);
    const stream = zlib.deflate(data, { level: 1 });
    return per(await timed(() => inflateEntry(zlib, stream, CAP, 12)), stream.length + CAP);
  },
  async "inflate: compressible at the cap"() {
    const data = wordsOf(CAP);
    const stream = zlib.deflate(data);
    return per(await timed(() => inflateEntry(zlib, stream, CAP, 12)), stream.length + CAP);
  },
  async "inflate: 16 random symbols, all literals through Huffman codes"() {
    const data = random(CAP, 13).map((b) => b & 15);
    const stream = zlib.deflate(data);
    return per(await timed(() => inflateEntry(zlib, stream, CAP, 12)), stream.length + CAP);
  },
  async "inflate: 200 random symbols, all literals through Huffman codes"() {
    const data = random(CAP, 14).map((b) => b % 200);
    const stream = zlib.deflate(data);
    return per(await timed(() => inflateEntry(zlib, stream, CAP, 12)), stream.length + CAP);
  },
  async "inflate: failing, near the end of 200 random symbols"() {
    const data = random(CAP, 15).map((b) => b % 200);
    const stream = zlib.deflate(data);
    const cut = stream.subarray(0, stream.length - 16);
    return per(
      await timed(() => {
        try {
          inflateEntry(zlib, cut, CAP, 12);
          throw new Error("expected more input");
        } catch (error) {
          if (!(error instanceof NeedMoreInput)) throw error;
        }
      }),
      cut.length + CAP,
    );
  },
  async "inflate: failing, stopped near the end of incompressible"() {
    const data = random(CAP, 2);
    const stream = zlib.deflate(data, { level: 1 });
    const cut = stream.subarray(0, stream.length - 16);
    return per(
      await timed(() => {
        try {
          inflateEntry(zlib, cut, CAP, 12);
          throw new Error("expected more input");
        } catch (error) {
          if (!(error instanceof NeedMoreInput)) throw error;
        }
      }),
      cut.length + CAP,
    );
  },
  async "inflate: failing, stopped near the end of compressible"() {
    const data = wordsOf(CAP);
    const stream = zlib.deflate(data);
    const cut = stream.subarray(0, stream.length - 16);
    return per(
      await timed(() => {
        try {
          inflateEntry(zlib, cut, CAP, 12);
          throw new Error("expected more input");
        } catch (error) {
          if (!(error instanceof NeedMoreInput)) throw error;
        }
      }),
      cut.length + CAP,
    );
  },
  async "apply: densest, one-byte copies from offset 0, two bytes an opcode"() {
    const base = random(CAP, 3);
    const count = Math.floor((CAP - 16) / 2);
    const delta = copiesOfOneByte(CAP, count, () => 0);
    return per(await timed(() => applyDelta(base, delta, CAP)), delta.length);
  },
  async "apply: five bytes an opcode, one-byte copies across the base"() {
    const base = random(CAP, 3);
    const count = Math.floor((CAP - 16) / 5);
    const delta = copiesOfOneByte(CAP, count, (k) => 0x010101 + (k % 0x100000));
    return per(await timed(() => applyDelta(base, delta, CAP)), delta.length);
  },
  async "apply: sparse 64 KiB copies to the result cap"() {
    const base = random(CAP, 4);
    const ops: { copy: [number, number] }[] = [];
    for (let at = 0; at < CAP; at += 0x10000) ops.push({ copy: [at, 0x10000] });
    const delta = encodeDelta(CAP, CAP, ops);
    return per(await timed(() => applyDelta(base, delta, CAP)), CAP);
  },
  async "apply: all literal, at the program cap"() {
    const literal = random(Math.floor((CAP - 16) * (127 / 128)), 5);
    const delta = encodeDelta(1, literal.length, [{ insert: literal }]);
    return per(await timed(() => applyDelta(new Uint8Array(1), delta, CAP)), delta.length);
  },
  async "returned copy: warm, at the cap"() {
    const data = random(CAP, 6);
    const r = await reader([{ kind: "blob", data }], indexed([{ kind: "blob", data }]));
    const oid = oidOf(0);
    return per(await timed(() => r.readObject(oid)), CAP);
  },
  async "returned copy and lookup: warm, 1 KiB"() {
    const data = random(KiB, 7);
    const r = await reader([{ kind: "blob", data }], indexed([{ kind: "blob", data }]));
    const oid = oidOf(0);
    return per(await timed(() => r.readObject(oid)), KiB + KiB);
  },
  async "lookup: a warm header read of a cached object"() {
    const data = random(KiB, 8);
    const r = await reader([{ kind: "blob", data }], indexed([{ kind: "blob", data }]));
    const oid = oidOf(0);
    await r.readObject(oid);
    return per(await timed(() => r.readHeader(oid)), KiB);
  },
  async "lookup: a warm header read through a 4,096-entry map"() {
    const entries: PackEntrySpec[] = Array.from({ length: 4096 }, (_, k) => ({
      kind: "blob" as const,
      data: Uint8Array.of(k & 255, k >> 8),
    }));
    const r = await reader(entries, indexed(entries), true);
    const oids = entries.map((_, k) => oidOf(k));
    for (const oid of oids) await r.readHeader(oid);
    let k = 0;
    return per(
      await timed(() => r.readHeader(oids[k++ % oids.length] as Uint8Array)),
      KiB + 64 * KiB,
    );
  },
  async "block run: warm, one block"() {
    const bytes = random(MiB, 9);
    const stats = createReadStats();
    const blocks = new BlockReader(
      "net-bench",
      { openRange: async (_id, o, n) => new Uint8Array(bytes.subarray(o, o + n)) },
      createClockBlockCache(),
      stats,
    );
    const pack = { packId: PACK_ID, bytes: bytes.length } as unknown as ViewPack;
    return per(await timed(() => blocks.read(pack, 100, 120)), 64 * KiB);
  },
  async "block run: warm, 72 blocks"() {
    const bytes = random(5 * MiB, 10);
    const stats = createReadStats();
    const blocks = new BlockReader(
      "net-bench",
      { openRange: async (_id, o, n) => new Uint8Array(bytes.subarray(o, o + n)) },
      createClockBlockCache(),
      stats,
    );
    const pack = { packId: PACK_ID, bytes: bytes.length } as unknown as ViewPack;
    return per(await timed(() => blocks.read(pack, 100, 72 * 64 * KiB - 1)), 72 * 64 * KiB);
  },
  async "deep path: 64 small trees, warm"() {
    const entries: PackEntrySpec[] = [];
    for (let k = 0; k < 64; k++) {
      entries.push({
        kind: "tree",
        data: treeBytes(4, () => oidOf(k + 1), "40000"),
      });
    }
    const r = await reader(entries, indexed(entries));
    return per(
      await timed(async () => {
        for (let k = 0; k < 64; k++) {
          const tree = await r.readObject(oidOf(k));
          for (const entry of treeEntries(tree?.bytes as Uint8Array))
            if (entry.oid[0] === 255) break;
        }
      }),
      64 * (KiB + 200),
    );
  },
  async "tree scan: to the last of a 4 MiB tree"() {
    const count = Math.floor(CAP / 44);
    const tree = treeBytes(count, oidOf);
    const name = new TextEncoder().encode(`file-${String(count - 1).padStart(8, "0")}.ts`);
    return per(
      await timed(() => {
        for (const e of treeEntries(tree)) {
          if (e.name.length === name.length && e.name.every((b, i) => b === name[i])) return e;
        }
        throw new Error("not found");
      }),
      tree.length,
    );
  },
  ...ALIGN_CASES,
  async "hash: SHA-256 of 2 MiB"() {
    const body = random(2 * MiB, 12);
    return per(await timed(() => crypto.subtle.digest("SHA-256", body)), 2 * MiB);
  },
};

/** What workerd's zlib hands back: exact buffers, or views of larger ones. */
function bufferShapes(): Record<string, unknown>[] {
  const sizes = [1, 64, 1024, 4096, 16384, 21845, 32767, 32768, 32769, 65535, 65536, 65537, CAP];
  return sizes.map((size) => {
    const stream = zlib.deflate(random(size, size));
    const { data } = inflateEntry(zlib, stream, size, 12);
    return { size, buffer: data.buffer.byteLength, offset: data.byteOffset };
  });
}

let held: ObjectReader | undefined;
let heldOids: Uint8Array[] = [];

/**
 * Opens a reader over a pack the driver built and sent, so nothing about
 * building it shows in the process's resident size: all that's left is
 * the small pack and the offsets.
 */
async function prepare(pack: Uint8Array, offsets: readonly number[]) {
  const where = new Map(offsets.map((offset, k) => [hex(oidOf(k)), offset]));
  const view: ViewPack = {
    packId: PACK_ID,
    bytes: pack.length,
    idx: {
      lookup: async (oid) => {
        const offset = where.get(hex(oid));
        return offset === undefined ? undefined : { position: 0, offset };
      },
      crc32At: async () => 0,
    },
  };
  held = await ObjectReader.open({
    view: { scope: "net-bench", packs: [view] },
    packStore: {
      openRange: async (_id, offset, length) =>
        new Uint8Array(pack.subarray(offset, offset + length)),
    },
    zlib,
    memory: createPrepaidMemory(12 * MiB),
    limits: { maxObjectBytes: CAP, deltaBaseCacheBytes: CACHE },
    strictDeltaCache: true,
  });
  heldOids = offsets.map((_, k) => oidOf(k));
  return { objects: offsets.length, packBytes: pack.length };
}

/** Reads the prepared objects in order `rounds` times, awaiting only what reads await. */
async function churn(rounds: number, yieldEvery: number) {
  if (!held) throw new Error("nothing prepared");
  let reads = 0;
  for (let round = 0; round < rounds; round++) {
    for (const oid of heldOids) {
      await held.readObject(oid);
      // What an R2 read does, and when the inspector's question gets answered.
      if (yieldEvery > 0 && ++reads % yieldEvery === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  return { reads };
}

/** One state decoded `runs` times: what a run of restores leaves behind, with only its own live set. */
async function stateChurn(runs: number, yieldEvery: number) {
  const encoded = encodeBlameState(stateOf(100_000));
  for (let run = 1; run <= runs; run++) {
    await decodeBlameState(encoded);
    if (yieldEvery > 0 && run % yieldEvery === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { runs };
}

const MEMORY: Record<string, (url: URL) => Promise<unknown>> = {
  async noop() {
    return { gc: typeof (globalThis as { gc?: unknown }).gc };
  },
  async shapes() {
    return bufferShapes();
  },
  churn: (url) =>
    churn(Number(url.searchParams.get("rounds")), Number(url.searchParams.get("yieldEvery"))),
  stateChurn: (url) =>
    stateChurn(Number(url.searchParams.get("runs")), Number(url.searchParams.get("yieldEvery"))),
  async collect() {
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    return { collected: gc !== undefined };
  },
  async drop() {
    held?.release();
    held = undefined;
    heldOids = [];
    (globalThis as { gc?: () => void }).gc?.();
    return {};
  },
};

const handler = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "";
    try {
      if (url.pathname === "/list") return Response.json(Object.keys(CASES));
      if (url.pathname === "/case") {
        const run = CASES[name];
        if (!run) return new Response(`no case ${name}`, { status: 404 });
        const runs = url.searchParams.get("runs");
        fixedRuns = runs === null ? undefined : Number(runs);
        return Response.json({ name, ...(await run()) });
      }
      if (url.pathname === "/prepare") {
        // How many entries, where each is, then the pack.
        const body = await request.arrayBuffer();
        const count = new DataView(body).getFloat64(0);
        const offsets = [...new Float64Array(body.slice(8, 8 + count * 8))];
        return Response.json(await prepare(new Uint8Array(body, 8 + count * 8), offsets));
      }
      if (url.pathname === "/memory") {
        const run = MEMORY[name];
        if (!run) return new Response(`no memory case ${name}`, { status: 404 });
        return Response.json(await run(url));
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      // The stack stays in workerd's log; the response names the error and its message only.
      console.error(error);
      const said = error instanceof Error ? `${error.name}: ${error.message}` : "Error";
      return new Response(said, { status: 500 });
    }
  },
};

export default handler;

/** One instance per name, so a case's timing can be read from outside on its own. */
export class BlameBench {
  fetch(request: Request): Promise<Response> {
    return handler.fetch(request);
  }
}
