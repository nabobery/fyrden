import { createSha1Hasher, Sha1 } from "../hash/sha1.js";
import { encodeObjectHeader, type ObjectType } from "../object/object.js";
import { OID_BYTES, type Oid, oidFromBytes, oidToHex } from "../object/oid.js";
import { crc32 } from "../pack/crc32.js";
import {
  decodeEntryHeader,
  type EntryHeaderFields,
  encodeEntryHeader,
  encodePackHeader,
  PACK_HEADER_BYTES,
} from "../pack/entry-header.js";
import { PackIdx } from "../pack/idx-read.js";
import { type IdxWriteInput, type WrittenIdx, writeIdx } from "../pack/idx-write.js";
import type { Hasher, HasherFactory, ResumableHasher } from "../ports/hasher.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import type { Zlib } from "../ports/zlib.js";
import { decodeCheckpoint, encodeCheckpoint } from "./checkpoint.js";
import { EntryTable, OidList } from "./entry-table.js";
import { PackWriteError } from "./errors.js";

/*
 * Streams a version 2 pack (git Documentation/gitformat-pack.adoc) to a
 * sink: the 12-byte header, the entries, the SHA-1 trailer. Nothing holds
 * the whole pack: output goes out in `chunkBytes` pieces, and memory holds
 * one chunk, one entry and the per-entry table (32 bytes per entry) that the
 * `.idx` is written from.
 *
 * The object count is fixed when the writer starts. The header holds it and
 * the trailer hashes the header first, so a count patched in at the end
 * would need a second pass over every byte. Every writer knows its count up
 * front: a regenerated fetch pack enumerates its objects before writing
 * them, and compaction counts the distinct objects of its sources from their
 * `.idx` files. A writer that ends with another count fails.
 *
 * Packs written here are self-contained (`finish` checks that every
 * REF_DELTA base is in the pack) and hold each object once, so
 * `git index-pack --strict` accepts them. The one exception is opt-in:
 * with `externalBases`, a REF_DELTA may name a base outside the pack that
 * the receiver is known to hold (a thin pack, for a fetch client that sent
 * `thin-pack`; gitformat-pack). No delta search is done: deltas appear only
 * when an existing entry is copied with `copyEntry`.
 */

/** Proposed default; tuned under load. */
export const DEFAULT_PACK_CHUNK_BYTES = 1024 * 1024;

/** Where pack bytes go. `PackWriter` fits. */
export interface PackSink {
  /** Appends bytes. The writer does not change `chunk` until the promise settles. */
  write(chunk: Uint8Array): Promise<void>;
}

export interface PackBuilderResumeOptions {
  readonly sink: PackSink;
  readonly zlib: Zlib;
  /** The output chunk and the entry table are reserved here before they are allocated. */
  readonly memory: MemoryBudget;
  /** Bytes per sink write (the last may be shorter). Default 1 MiB. */
  readonly chunkBytes?: number;
  /** zlib level for whole objects, 0 to 9. Default: zlib's default, as git's `pack.compression`. */
  readonly compressionLevel?: number;
  /**
   * Check each copied entry against the CRC32 its source `.idx` gives, so a
   * corrupt source is not copied on. Default true.
   */
  readonly verifyCopies?: boolean;
  /** Hashes the `.idx` checksum. Default: git-core's SHA-1 without collision detection. */
  readonly createIdxHasher?: HasherFactory;
  /**
   * Objects the receiver is known to hold. A REF_DELTA whose base is not in
   * the pack is accepted by `finish` when its base is here, and the pack
   * is then thin. Only for a receiver that asked for a thin pack and whose
   * holdings are proven (a fetch client's common commits). Default: none,
   * every base must be in the pack. Not saved by `checkpoint`; pass it to
   * `resume` again.
   */
  readonly externalBases?: { has(oid: Uint8Array): boolean };
}

export interface PackBuilderOptions extends PackBuilderResumeOptions {
  /**
   * The trailer hasher. Default: git-core's resumable SHA-1 without collision
   * detection (Fyrden writes these bytes). `checkpoint` needs a hasher with
   * `saveState`.
   */
  readonly createHasher?: () => Hasher | ResumableHasher;
  /**
   * Write copied deltas whose base is already in the pack as OFS_DELTA.
   * False for a client that did not ask for `ofs-delta`. Default true.
   */
  readonly ofsDelta?: boolean;
}

/** An entry as stored in an existing pack. */
export interface CopiedEntry {
  readonly oid: Uint8Array;
  /** The entry's bytes in its source pack: entry header, then the zlib stream. */
  readonly bytes: Uint8Array;
  /** The entry's offset in its source pack (an OFS_DELTA header is relative to it). */
  readonly offset: number;
  /** The CRC32 from the source `.idx`. When given, a verbatim copy reuses it. */
  readonly crc32?: number;
}

/** Where a copied delta's base is in the pack being written. */
export interface DeltaBase {
  readonly oid: Uint8Array;
  /**
   * The base's offset in this pack when it is already written. Without it,
   * the delta is written as a REF_DELTA and the base must be added later.
   */
  readonly offset?: number | undefined;
}

export interface FinishedPack {
  /** The trailer: SHA-1 of everything before it. */
  readonly checksum: Uint8Array;
  /** Bytes written, trailer included. */
  readonly packLength: number;
  readonly objectCount: number;
  /** Oid, offset and CRC32 per entry, in pack order. */
  readonly entries: IdxWriteInput;
  /** The pack's `.idx`, as `git index-pack` writes it. */
  readonly idx: WrittenIdx;
  /** REF_DELTA bases outside the pack (allowed by `externalBases`), each once. Empty unless thin. */
  readonly externalBases: readonly Oid[];
  /** Returns the entry table and the `.idx` to the memory budget. */
  release(): void;
}

const MAX_OBJECT_COUNT = 0xffffffff;

export class PackBuilder {
  readonly objectCount: number;
  readonly #sink: PackSink;
  readonly #zlib: Zlib;
  readonly #memory: MemoryBudget;
  readonly #hasher: Hasher;
  readonly #ofsDelta: boolean;
  readonly #verify: boolean;
  readonly #level: number | undefined;
  readonly #createIdxHasher: HasherFactory;
  readonly #externalBases: { has(oid: Uint8Array): boolean } | undefined;
  readonly #entries: EntryTable;
  readonly #refBases: OidList;
  readonly #chunk: Uint8Array;
  readonly #chunkReservation: MemoryReservation;
  #fill = 0;
  /** Bytes flushed to the sink and the hasher. */
  #flushed: number;
  #state: "open" | "finished" | "failed" = "open";

  private constructor(init: {
    objectCount: number;
    options: PackBuilderResumeOptions;
    hasher: Hasher;
    ofsDelta: boolean;
    flushed: number;
    chunkReservation: MemoryReservation;
    chunkBytes: number;
  }) {
    const { options } = init;
    this.objectCount = init.objectCount;
    this.#sink = options.sink;
    this.#zlib = options.zlib;
    this.#memory = options.memory;
    this.#hasher = init.hasher;
    this.#ofsDelta = init.ofsDelta;
    this.#verify = options.verifyCopies ?? true;
    this.#level = options.compressionLevel;
    this.#createIdxHasher =
      options.createIdxHasher ?? (() => createSha1Hasher({ detectCollisions: false }));
    this.#externalBases = options.externalBases;
    this.#entries = new EntryTable(options.memory, init.objectCount);
    this.#refBases = new OidList(options.memory);
    this.#chunk = new Uint8Array(init.chunkBytes);
    this.#chunkReservation = init.chunkReservation;
    this.#flushed = init.flushed;
  }

  /** Starts a pack of `objectCount` entries and writes its header. */
  static async start(objectCount: number, options: PackBuilderOptions): Promise<PackBuilder> {
    if (!Number.isInteger(objectCount) || objectCount < 0 || objectCount > MAX_OBJECT_COUNT) {
      throw new RangeError(
        `object count must be an integer from 0 to 2^32 - 1, not ${objectCount}`,
      );
    }
    const chunkBytes = checkChunkBytes(options.chunkBytes);
    const builder = new PackBuilder({
      objectCount,
      options,
      hasher: (options.createHasher ?? defaultHasher)(),
      ofsDelta: options.ofsDelta ?? true,
      flushed: 0,
      chunkReservation: await options.memory.reserve(chunkBytes),
      chunkBytes,
    });
    // A builder that fails here never reaches the caller: return its memory.
    try {
      await builder.#emit(encodePackHeader(objectCount));
    } catch (error) {
      builder.release();
      throw error;
    }
    return builder;
  }

  /**
   * Continues a writer from a `checkpoint()` result. The sink must continue
   * right after the bytes written before the checkpoint (for example the
   * next part of the same multipart upload).
   */
  static async resume(
    checkpoint: Uint8Array,
    options: PackBuilderResumeOptions,
  ): Promise<PackBuilder> {
    const saved = decodeCheckpoint(checkpoint);
    const chunkBytes = checkChunkBytes(options.chunkBytes);
    let hasher: ResumableHasher;
    try {
      hasher = createSha1Hasher(saved.hasherState);
    } catch (error) {
      throw new PackWriteError("bad-checkpoint", `hasher state: ${(error as Error).message}`);
    }
    const builder = new PackBuilder({
      objectCount: saved.objectCount,
      options,
      hasher,
      ofsDelta: saved.ofsDelta,
      flushed: saved.offset,
      chunkReservation: await options.memory.reserve(chunkBytes),
      chunkBytes,
    });
    // A builder that fails here never reaches the caller: return its memory.
    try {
      const table = builder.#entries;
      await table.ensure(saved.count);
      table.oids.set(saved.oids);
      table.offsets.set(saved.offsets);
      table.crc32s.set(saved.crc32s);
      table.count = saved.count;
      await builder.#refBases.ensure(saved.refBaseCount);
      builder.#refBases.bytes.set(saved.refBases);
      builder.#refBases.count = saved.refBaseCount;
    } catch (error) {
      builder.release();
      throw error;
    }
    return builder;
  }

  /** Entries written so far. */
  get count(): number {
    return this.#entries.count;
  }

  /** The offset the next entry gets: bytes written so far. */
  get offset(): number {
    return this.#flushed + this.#fill;
  }

  /** The offset of the `index`-th entry written. */
  offsetOf(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.#entries.count) {
      throw new RangeError(`no entry ${index}`);
    }
    return this.#entries.offsets[index] as number;
  }

  /**
   * Adds a whole object, deflated. `oid` is the object's id when the caller
   * knows it; otherwise it is computed. Returns the entry's offset.
   */
  async addObject(type: ObjectType, data: Uint8Array, oid?: Uint8Array): Promise<number> {
    this.#beginEntry();
    const id =
      oid ??
      new Sha1({ detectCollisions: false })
        .update(encodeObjectHeader(type, data.length))
        .update(data)
        .digest();
    const offset = this.offset;
    const header = encodeEntryHeader({ kind: type, size: data.length }, offset);
    const body = this.#zlib.deflate(
      data,
      this.#level === undefined ? undefined : { level: this.#level },
    );
    return this.#writeEntry(id, offset, header, body, crc32(body, crc32(header)));
  }

  /**
   * Copies an entry of an existing pack without inflating it. A whole object
   * is copied byte for byte. A delta needs its `base`: it becomes an
   * OFS_DELTA when the base is already written here (and `ofsDelta` is on),
   * otherwise a REF_DELTA; the header is rewritten only when that changes
   * it. A delta whose base will not be in this pack must not be copied: add
   * the object whole instead. Returns the entry's offset.
   */
  async copyEntry(entry: CopiedEntry, base?: DeltaBase): Promise<number> {
    this.#beginEntry();
    const { bytes } = entry;
    let header: ReturnType<typeof decodeEntryHeader>;
    try {
      header = decodeEntryHeader(bytes, 0, entry.offset, Number.MAX_SAFE_INTEGER);
    } catch (error) {
      throw new PackWriteError("corrupt-source", `entry header: ${(error as Error).message}`);
    }
    if (header === undefined || header.length >= bytes.length) {
      throw new PackWriteError("corrupt-source", "copied entry is truncated");
    }
    if (this.#verify && entry.crc32 !== undefined && crc32(bytes) !== entry.crc32) {
      throw new PackWriteError("corrupt-source", "copied entry does not match its CRC32");
    }
    const offset = this.offset;
    if (header.kind !== "ofs-delta" && header.kind !== "ref-delta") {
      return this.#writeEntry(entry.oid, offset, undefined, bytes, entry.crc32 ?? crc32(bytes));
    }
    if (base === undefined) throw new RangeError("a copied delta needs its base");
    let fields: EntryHeaderFields;
    if (base.offset !== undefined && this.#ofsDelta) {
      if (
        !Number.isSafeInteger(base.offset) ||
        base.offset < PACK_HEADER_BYTES ||
        base.offset >= offset
      ) {
        throw new RangeError(`OFS_DELTA base offset ${base.offset} is not before ${offset}`);
      }
      fields = { kind: "ofs-delta", size: header.size, baseOffset: base.offset };
    } else {
      fields = { kind: "ref-delta", size: header.size, baseOid: oidFromBytes(base.oid) };
    }
    const newHeader = encodeEntryHeader(fields, offset);
    if (fields.kind === "ref-delta") await this.#refBases.add(base.oid);
    if (sameBytes(newHeader, bytes.subarray(0, header.length))) {
      return this.#writeEntry(entry.oid, offset, undefined, bytes, entry.crc32 ?? crc32(bytes));
    }
    const body = bytes.subarray(header.length);
    return this.#writeEntry(entry.oid, offset, newHeader, body, crc32(body, crc32(newHeader)));
  }

  /**
   * Flushes buffered bytes to the sink and returns the writer's state, to
   * persist (for example in scratch storage) and pass to `resume`. Persist
   * it only after the sink has made the flushed bytes durable.
   */
  async checkpoint(): Promise<Uint8Array> {
    this.#requireOpen();
    const hasher = this.#hasher as Partial<ResumableHasher>;
    if (typeof hasher.saveState !== "function") {
      throw new PackWriteError("not-resumable", "the trailer hasher cannot save its state");
    }
    await this.#flush();
    const table = this.#entries;
    return encodeCheckpoint({
      objectCount: this.objectCount,
      ofsDelta: this.#ofsDelta,
      offset: this.#flushed,
      count: table.count,
      hasherState: hasher.saveState(),
      oids: table.oids.subarray(0, table.count * OID_BYTES),
      offsets: table.offsets.subarray(0, table.count),
      crc32s: table.crc32s.subarray(0, table.count),
      refBaseCount: this.#refBases.count,
      refBases: this.#refBases.bytes.subarray(0, this.#refBases.count * OID_BYTES),
    });
  }

  /**
   * Checks the pack (object count, no duplicate objects, every REF_DELTA
   * base present), writes the `.idx`, then the trailer. Nothing more is
   * written to the sink when a check fails: abort the upload.
   */
  async finish(): Promise<FinishedPack> {
    this.#requireOpen();
    this.#state = "failed";
    const table = this.#entries;
    if (table.count !== this.objectCount) {
      throw new PackWriteError(
        "object-count",
        `the header declares ${this.objectCount} objects, ${table.count} were written`,
      );
    }
    await this.#flush();
    this.#chunkReservation.release();
    const checksum = await this.#hasher.digest();
    const entries: IdxWriteInput = {
      count: table.count,
      oids: table.oids,
      offsets: table.offsets,
      crc32s: table.crc32s,
    };
    // Strict, as `git index-pack --strict`: refuses an object written twice.
    const idx = await writeIdx(entries, checksum, {
      createHasher: this.#createIdxHasher,
      strict: true,
      memory: this.#memory,
    });
    let externalBases: Oid[];
    try {
      externalBases = this.#checkRefBases(PackIdx.parse(idx.bytes));
      await this.#sink.write(checksum);
    } catch (error) {
      idx.release();
      throw error;
    }
    this.#state = "finished";
    const packLength = this.#flushed + checksum.length;
    this.#refBases.release();
    return {
      checksum,
      packLength,
      objectCount: this.objectCount,
      entries,
      idx,
      externalBases,
      release: () => {
        table.release();
        idx.release();
      },
    };
  }

  /** Returns every reservation; the builder cannot be used afterwards. */
  release(): void {
    this.#state = "failed";
    this.#chunkReservation.release();
    this.#entries.release();
    this.#refBases.release();
  }

  /** Throws for a REF_DELTA base that is neither in the pack nor allowed; returns the allowed ones. */
  #checkRefBases(idx: PackIdx): Oid[] {
    const bases = this.#refBases;
    const external = new Map<string, Oid>();
    for (let i = 0; i < bases.count; i++) {
      if (idx.find(bases.bytes, i * OID_BYTES) >= 0) continue;
      const oid = oidFromBytes(bases.bytes, i * OID_BYTES);
      if (!this.#externalBases?.has(oid)) {
        throw new PackWriteError(
          "missing-base",
          `REF_DELTA base ${oidToHex(oid)} is not in the pack`,
        );
      }
      external.set(oidToHex(oid), oid);
    }
    return [...external.values()];
  }

  #beginEntry(): void {
    this.#requireOpen();
    if (this.#entries.count >= this.objectCount) {
      throw new PackWriteError(
        "object-count",
        `the header declares ${this.objectCount} objects; no room for another`,
      );
    }
  }

  async #writeEntry(
    oid: Uint8Array,
    offset: number,
    header: Uint8Array | undefined,
    body: Uint8Array,
    crc: number,
  ): Promise<number> {
    if (oid.length < OID_BYTES) throw new RangeError("an object id is 20 bytes");
    try {
      if (header) await this.#emit(header);
      await this.#emit(body);
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
    await this.#entries.add(oid, offset, crc);
    return offset;
  }

  async #emit(bytes: Uint8Array): Promise<void> {
    const chunk = this.#chunk;
    let at = 0;
    while (at < bytes.length) {
      if (this.#fill === 0 && bytes.length - at >= chunk.length) {
        // A whole chunk or more: pass it through without copying.
        const piece = bytes.subarray(at);
        await this.#out(piece);
        at = bytes.length;
        break;
      }
      const take = Math.min(chunk.length - this.#fill, bytes.length - at);
      chunk.set(bytes.subarray(at, at + take), this.#fill);
      this.#fill += take;
      at += take;
      if (this.#fill === chunk.length) await this.#flush();
    }
  }

  async #flush(): Promise<void> {
    if (this.#fill === 0) return;
    const fill = this.#fill;
    await this.#out(this.#chunk.subarray(0, fill));
    this.#fill = 0;
  }

  async #out(bytes: Uint8Array): Promise<void> {
    await this.#hasher.update(bytes);
    await this.#sink.write(bytes);
    this.#flushed += bytes.length;
  }

  #requireOpen(): void {
    if (this.#state !== "open") throw new Error(`pack builder is ${this.#state}`);
  }
}

function defaultHasher(): ResumableHasher {
  return createSha1Hasher({ detectCollisions: false });
}

function checkChunkBytes(chunkBytes = DEFAULT_PACK_CHUNK_BYTES): number {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new RangeError(`chunkBytes must be a positive integer, not ${chunkBytes}`);
  }
  return chunkBytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
