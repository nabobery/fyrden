import { Sha1 } from "../hash/sha1.js";
import { encodeObjectHeader } from "../object/object.js";
import { type Oid, oidEquals, oidFromBytes, oidToHex } from "../object/oid.js";
import { decodeEntryHeader, PACK_TRAILER_BYTES } from "../pack/entry-header.js";
import type { ExternalBaseLookup } from "../pack/parse.js";
import type { MemoryBudget } from "../ports/memory-budget.js";
import type { Zlib } from "../ports/zlib.js";
import { CompactionPlan, type CompactionSource, DROPPED } from "./compaction-plan.js";
import { PackWriteError } from "./errors.js";
import { type DeltaBase, type FinishedPack, PackBuilder, type PackSink } from "./pack-builder.js";
import { type PackRangeRead, WindowReader } from "./window-reader.js";

export type { CompactionSource } from "./compaction-plan.js";

/*
 * Compaction without delta search: several packs become one self-contained pack and its
 * `.idx`. Each source's entries are copied in pack order, so a source's
 * region stays contiguous and its OFS_DELTA distances stay valid; the CRC32
 * of every entry copied unchanged comes from the source `.idx`.
 *
 * An entry is rewritten only when it must be:
 * - its object is stored more than once: the other copies are dropped (see
 *   compaction-plan.ts), and an OFS_DELTA whose base was a dropped copy gets
 *   a new distance, or becomes a REF_DELTA when the kept copy comes later;
 * - it is a REF_DELTA whose base is in no source (a thin pack compacted
 *   without the pack that holds its bases), or a delta whose base a keep
 *   set leaves out: it is written whole;
 * - it is a delta whose base is a duplicated object whose kept copy is
 *   itself a delta it was not originally resolved against: written whole,
 *   since keeping the edge could close a delta cycle across sources.
 * Whole objects come from `resolveObject` (the repository's object reader).
 *
 * The work is resumable: `run` copies a bounded number of entries,
 * `checkpoint` saves the writer, and `Compaction.resume` continues on the
 * same sources (the plan is recomputed, not saved).
 */

/** Proposed default; tuned under load. */
export const DEFAULT_COMPACTION_READ_BYTES = 8 * 1024 * 1024;

export interface CompactionOptions {
  /** Range reads of the source packs (`PackStore.openRange`). */
  readonly read: PackRangeRead;
  /** Where the new pack goes: a `PackWriter` from `PackStore.beginPack`. */
  readonly sink: PackSink;
  readonly zlib: Zlib;
  /** Plan arrays, read windows, the output chunk and the entry table are reserved here. */
  readonly memory: MemoryBudget;
  /** Objects that must be written whole. Without it, needing one fails with `missing-base`. */
  readonly resolveObject?: ExternalBaseLookup;
  /** Bytes per source read. Default 8 MiB. */
  readonly readBytes?: number;
  /** Bytes per sink write. Default: the pack builder's. */
  readonly chunkBytes?: number;
}

/*
 * Checkpoint: "FPCC", version (1 byte), source count (2 bytes), then per
 * source its pack id (26 ASCII bytes) and length (8-byte float), then the
 * pack writer's checkpoint.
 */
const MAGIC = [0x46, 0x50, 0x43, 0x43]; // "FPCC"
const VERSION = 1;
const SOURCES_AT = 7;
const PACK_ID_BYTES = 26;
const SOURCE_BYTES = PACK_ID_BYTES + 8;

export class Compaction {
  readonly #plan: CompactionPlan;
  readonly #builder: PackBuilder;
  readonly #reader: WindowReader;
  readonly #options: CompactionOptions;
  /** Index into the plan's output order of the next entry to look at. */
  #cursor = 0;

  private constructor(
    plan: CompactionPlan,
    builder: PackBuilder,
    reader: WindowReader,
    options: CompactionOptions,
  ) {
    this.#plan = plan;
    this.#builder = builder;
    this.#reader = reader;
    this.#options = options;
    // Skip what a resumed writer already wrote.
    for (let written = 0; written < builder.count; this.#cursor++) {
      if (plan.outIndex[plan.order[this.#cursor] as number] !== DROPPED) written++;
    }
    this.#skipDropped();
  }

  static async start(
    sources: readonly CompactionSource[],
    options: CompactionOptions,
  ): Promise<Compaction> {
    const reader = newReader(options);
    let plan: CompactionPlan | undefined;
    // Planning reads through the window, so it is inside the guard: a caller
    // that gets no compaction cannot release it.
    try {
      plan = await CompactionPlan.build(sources, reader, options.memory);
      const builder = await PackBuilder.start(plan.objectCount, {
        sink: options.sink,
        zlib: options.zlib,
        memory: options.memory,
        ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
      });
      return new Compaction(plan, builder, reader, options);
    } catch (error) {
      plan?.release();
      reader.release();
      throw error;
    }
  }

  /** Continues from `checkpoint()` over the same sources, writing to `options.sink`. */
  static async resume(
    sources: readonly CompactionSource[],
    checkpoint: Uint8Array,
    options: CompactionOptions,
  ): Promise<Compaction> {
    const writerState = checkSources(checkpoint, sources);
    const reader = newReader(options);
    let plan: CompactionPlan | undefined;
    try {
      plan = await CompactionPlan.build(sources, reader, options.memory);
      const builder = await PackBuilder.resume(writerState, {
        sink: options.sink,
        zlib: options.zlib,
        memory: options.memory,
        ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
      });
      if (builder.objectCount !== plan.objectCount) {
        builder.release();
        throw new PackWriteError("bad-checkpoint", "the checkpoint is for another object count");
      }
      return new Compaction(plan, builder, reader, options);
    } catch (error) {
      plan?.release();
      reader.release();
      throw error;
    }
  }

  /** Objects in the output. */
  get objectCount(): number {
    return this.#plan.objectCount;
  }

  /** Copies up to `maxEntries` more entries. Returns true when every entry is written. */
  async run(maxEntries = Number.POSITIVE_INFINITY): Promise<boolean> {
    const plan = this.#plan;
    for (let n = 0; n < maxEntries && this.#cursor < plan.total; n++) {
      await this.#copy(plan.order[this.#cursor] as number);
      this.#cursor++;
      this.#skipDropped();
    }
    return this.#cursor >= plan.total;
  }

  /** The state to persist and pass to `resume`, after the sink has the bytes written so far. */
  async checkpoint(): Promise<Uint8Array> {
    const writer = await this.#builder.checkpoint();
    const sources = this.#plan.sources;
    const out = new Uint8Array(SOURCES_AT + sources.length * SOURCE_BYTES + writer.length);
    const view = new DataView(out.buffer);
    out.set(MAGIC);
    out[4] = VERSION;
    view.setUint16(5, sources.length);
    sources.forEach((s, i) => {
      for (let c = 0; c < PACK_ID_BYTES; c++)
        out[SOURCES_AT + i * SOURCE_BYTES + c] = s.packId.charCodeAt(c);
      view.setFloat64(SOURCES_AT + i * SOURCE_BYTES + PACK_ID_BYTES, s.packLength);
    });
    out.set(writer, SOURCES_AT + sources.length * SOURCE_BYTES);
    return out;
  }

  /** Writes the trailer and the `.idx`; call after `run` returned true. */
  async finish(): Promise<FinishedPack> {
    if (this.#cursor < this.#plan.total) throw new Error("compaction is not done");
    try {
      return await this.#builder.finish();
    } catch (error) {
      this.#builder.release();
      throw error;
    } finally {
      this.#plan.release();
      this.#reader.release();
    }
  }

  /** Returns every reservation; the compaction cannot be used afterwards. */
  release(): void {
    this.#builder.release();
    this.#plan.release();
    this.#reader.release();
  }

  #skipDropped(): void {
    const plan = this.#plan;
    while (
      this.#cursor < plan.total &&
      plan.outIndex[plan.order[this.#cursor] as number] === DROPPED
    ) {
      this.#cursor++;
    }
  }

  async #copy(g: number): Promise<void> {
    const plan = this.#plan;
    const s = plan.sourceOf(g);
    const source = plan.sources[s] as CompactionSource;
    const position = g - (plan.firsts[s] as number);
    const offset = plan.offsetOf(g, s);
    const bytes = await this.#reader.bytes(
      source.packId,
      offset,
      plan.endOf(g, s) - offset,
      source.packLength - PACK_TRAILER_BYTES,
    );
    const oid = source.idx.oidAt(position);
    let header: ReturnType<typeof decodeEntryHeader>;
    try {
      header = decodeEntryHeader(bytes, 0, offset, Number.MAX_SAFE_INTEGER);
    } catch (error) {
      throw new PackWriteError("corrupt-source", `entry header: ${(error as Error).message}`);
    }
    if (header === undefined) throw new PackWriteError("corrupt-source", "entry is truncated");
    const entry = { oid, bytes, offset, crc32: source.idx.crc32At(position) };
    if (header.kind !== "ofs-delta" && header.kind !== "ref-delta") {
      await this.#builder.copyEntry(entry);
      return;
    }
    const base =
      header.kind === "ofs-delta"
        ? this.#ofsBase(s, header.baseOffset)
        : this.#refBase(header.baseOid);
    if (base === undefined) await this.#writeWhole(oid);
    else await this.#builder.copyEntry(entry, base);
  }

  /** Where an OFS_DELTA's base is in the output, or undefined to write the entry whole. */
  #ofsBase(s: number, baseOffset: number): DeltaBase | undefined {
    const plan = this.#plan;
    const g = plan.entryAt(s, baseOffset);
    if (g < 0) {
      throw new PackWriteError("corrupt-source", `OFS_DELTA base at ${baseOffset} is not an entry`);
    }
    // A base the keep set leaves out is not written: write the delta whole.
    if (plan.isExcluded(g)) return undefined;
    const source = plan.sources[s] as CompactionSource;
    const oid = source.idx.oidAt(g - (plan.firsts[s] as number));
    const kept = plan.canonical[g] as number;
    // The kept copy is the base this delta was made against, or a whole copy.
    if (kept !== g && plan.isKnownDelta(kept)) return undefined;
    const out = plan.outIndex[kept] as number;
    return { oid, offset: out < this.#builder.count ? this.#builder.offsetOf(out) : undefined };
  }

  /** A REF_DELTA's base, kept as a REF_DELTA, or undefined to write the entry whole. */
  #refBase(oid: Uint8Array): DeltaBase | undefined {
    const plan = this.#plan;
    const g = plan.findKept(oid);
    if (g < 0) return undefined;
    // Stored once: the copy this delta was resolved against. Stored more
    // than once: safe only when the kept copy is whole.
    if (plan.isDuplicated(g) && plan.isKnownDelta(g)) return undefined;
    return { oid };
  }

  async #writeWhole(oid: Oid): Promise<void> {
    const found = await this.#options.resolveObject?.(oid);
    const hex = oidToHex(oid);
    if (found === undefined) {
      throw new PackWriteError(
        "missing-base",
        `object ${hex} must be written whole and was not found`,
      );
    }
    const id = new Sha1({ detectCollisions: false })
      .update(encodeObjectHeader(found.type, found.data.length))
      .update(found.data)
      .digest();
    if (!oidEquals(oidFromBytes(id), oid)) {
      throw new PackWriteError("corrupt-source", `object ${hex} read back with other contents`);
    }
    await this.#builder.addObject(found.type, found.data, oid);
  }
}

/** Compacts `sources` in one go. */
export async function compactPacks(
  sources: readonly CompactionSource[],
  options: CompactionOptions,
): Promise<FinishedPack> {
  const job = await Compaction.start(sources, options);
  try {
    await job.run();
  } catch (error) {
    job.release();
    throw error;
  }
  return job.finish();
}

function newReader(options: CompactionOptions): WindowReader {
  return new WindowReader(
    options.read,
    options.readBytes ?? DEFAULT_COMPACTION_READ_BYTES,
    options.memory,
  );
}

/** Checks the checkpoint names these sources; returns the writer's part. */
function checkSources(checkpoint: Uint8Array, sources: readonly CompactionSource[]): Uint8Array {
  const bad = (why: string) => new PackWriteError("bad-checkpoint", why);
  if (checkpoint.length < SOURCES_AT || MAGIC.some((b, i) => checkpoint[i] !== b)) {
    throw bad("not a compaction checkpoint");
  }
  if (checkpoint[4] !== VERSION) throw bad(`version ${checkpoint[4]} is not supported`);
  const view = new DataView(checkpoint.buffer, checkpoint.byteOffset, checkpoint.byteLength);
  const count = view.getUint16(5);
  const writerAt = SOURCES_AT + count * SOURCE_BYTES;
  if (count !== sources.length || checkpoint.length < writerAt) {
    throw bad("the checkpoint is for other sources");
  }
  sources.forEach((s, i) => {
    const at = SOURCES_AT + i * SOURCE_BYTES;
    const id = String.fromCharCode(...checkpoint.subarray(at, at + PACK_ID_BYTES));
    if (id !== s.packId || view.getFloat64(at + PACK_ID_BYTES) !== s.packLength) {
      throw bad("the checkpoint is for other sources");
    }
  });
  return checkpoint.subarray(writerAt);
}
