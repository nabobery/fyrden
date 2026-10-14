import { copyBytes } from "../object/bytes.js";
import { isObjectType, type ObjectType } from "../object/object.js";
import { OID_BYTES, type Oid, oidFromBytes, oidToHex } from "../object/oid.js";
import { applyDelta, readDeltaHeader } from "../pack/delta-apply.js";
import type { EntryHeader } from "../pack/entry-header.js";
import { PackError } from "../pack/errors.js";
import { reservePackMemory } from "../pack/memory.js";
import { DEFAULT_PACK_LIMITS } from "../pack/parse.js";
import type { BlockCache } from "../ports/block-cache.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import type { PackStore } from "../ports/pack-store.js";
import type { Zlib } from "../ports/zlib.js";
import { BlockReader, type PackBytesSource } from "./block-reader.js";
import { type CachedObject, DeltaBaseCache } from "./delta-base-cache.js";
import { type EntryHead, readEntry, readEntryHead, readEntryHeader } from "./entry-reader.js";
import { MissingObjectError } from "./errors.js";
import { SequentialPackReader } from "./range-planner.js";
import { createReadStats, type ReadStats } from "./stats.js";
import { checkView, type RepoView, type ViewPack } from "./view.js";

/**
 * Most bytes of entry reads kept while a delta chain is followed (so each
 * small entry is read from the source once). Larger entries are read again
 * when their turn comes.
 */
const CHAIN_READ_BYTES = 256 * 1024;

export interface ReaderLimits {
  /** Largest object or delta result, as the parser caps it (32 MiB). */
  readonly maxObjectBytes: number;
  /** Longest delta chain followed; also stops REF_DELTA cycles across packs. */
  readonly maxDeltaDepth: number;
  /** Delta-base cache size, reserved from the memory budget for the reader's life. Proposed: 16 MiB. */
  readonly deltaBaseCacheBytes: number;
  /** Size of each sequential read in `walk`. Proposed: 8 MiB; tuned under load. */
  readonly rangeBytes: number;
}

export const DEFAULT_READER_LIMITS: ReaderLimits = {
  maxObjectBytes: DEFAULT_PACK_LIMITS.maxObjectBytes,
  maxDeltaDepth: DEFAULT_PACK_LIMITS.maxDeltaDepth,
  deltaBaseCacheBytes: 16 * 1024 * 1024,
  rangeBytes: 8 * 1024 * 1024,
};

export interface ObjectReaderOptions {
  /** The repository's packs; the reader reads no others. */
  readonly view: RepoView;
  readonly packStore: Pick<PackStore, "openRange">;
  readonly zlib: Zlib;
  /** The delta-base cache and each walk's range buffer are reserved here. */
  readonly memory: MemoryBudget;
  /** Shared 64 KiB block cache for random reads; without one, every read goes to the store. */
  readonly blockCache?: BlockCache;
  /** Read counts for this request's metrics; the reader adds to it. */
  readonly stats?: ReadStats;
  readonly limits?: Partial<ReaderLimits>;
}

export interface StoredObject {
  readonly type: ObjectType;
  /** The object's bytes, owned by the caller. */
  readonly bytes: Uint8Array;
}

export interface ObjectHeaderInfo {
  readonly type: ObjectType;
  readonly size: number;
}

export interface WalkedObject extends StoredObject {
  readonly oid: Oid;
}

/** An entry's place in the view: which pack, and where in it. */
interface Location {
  readonly pack: number;
  readonly offset: number;
}

/**
 * Reads objects from one repository's packs for one operation (a request,
 * or one maintenance job). Lookup follows the view's order and asks each
 * pack's existence summary before its `.idx`. Random reads go through the
 * block cache to the pack store; `walk` reads many objects in pack order
 * with large sequential ranges. Deltas (OFS and REF) are resolved through a
 * per-operation delta-base cache; REF_DELTA bases are found by oid across
 * the whole view, so a thin pack and its completion pack read as one.
 *
 * Authorization: the reader has no call that takes a pack id or a block
 * index. It reads only the packs of the view it was opened with, and keys
 * every cached block by the view's scope, so it cannot reach a pack outside
 * the repository's registry. Which objects a caller may see is checked
 * before the reader is asked for them (commit context, wants reachable
 * from the refs).
 *
 * Call `release()` when the operation ends, to return the reserved memory.
 */
export class ObjectReader {
  readonly stats: ReadStats;
  readonly #view: RepoView;
  readonly #store: Pick<PackStore, "openRange">;
  readonly #zlib: Zlib;
  readonly #memory: MemoryBudget;
  readonly #limits: ReaderLimits;
  readonly #blocks: BlockReader;
  readonly #cache: DeltaBaseCache;
  readonly #reservation: MemoryReservation;
  /** Where `prefetch` found objects, by hex oid (undefined: in no pack of the view). */
  readonly #located = new Map<string, Location | undefined>();
  #released = false;

  private constructor(
    options: ObjectReaderOptions,
    limits: ReaderLimits,
    stats: ReadStats,
    reservation: MemoryReservation,
  ) {
    this.#view = options.view;
    this.#store = options.packStore;
    this.#zlib = options.zlib;
    this.#memory = options.memory;
    this.#limits = limits;
    this.stats = stats;
    this.#reservation = reservation;
    this.#blocks = new BlockReader(
      options.view.scope,
      options.packStore,
      options.blockCache,
      stats,
    );
    this.#cache = new DeltaBaseCache(limits.deltaBaseCacheBytes);
  }

  /**
   * Opens a reader, waiting for the delta-base cache's memory. Throws
   * RangeError for a malformed view or bad limits.
   */
  static async open(options: ObjectReaderOptions): Promise<ObjectReader> {
    checkView(options.view);
    const limits = checkLimits({ ...DEFAULT_READER_LIMITS, ...options.limits });
    const reservation = await options.memory.reserve(limits.deltaBaseCacheBytes);
    return new ObjectReader(options, limits, options.stats ?? createReadStats(), reservation);
  }

  /** Drops the delta-base cache and returns its memory. Calling it twice has no effect. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#cache.clear();
    this.#reservation.release();
  }

  /** Whether a pack of the view holds the object. */
  async has(oid: Uint8Array): Promise<boolean> {
    this.#checkOpen();
    return (await this.#locate(oid)) !== undefined;
  }

  /**
   * Finds where `oids` are with each pack's batched `.idx` lookup (a few
   * coalesced reads per pack instead of a few per object), so the reads
   * that follow for them skip their own lookups. Packs without a batched
   * lookup are left to the per-object path.
   */
  async prefetch(oids: Iterable<Uint8Array>): Promise<void> {
    this.#checkOpen();
    let pending = [...oids].filter((oid) => !this.#located.has(oidHex(oid)));
    // Any pack holding an object gives the same object; only "in no pack"
    // needs every pack asked.
    let everyPack = true;
    for (let index = 0; index < this.#view.packs.length && pending.length > 0; index++) {
      const pack = this.#view.packs[index] as ViewPack;
      if (!pack.idx.lookupMany) {
        everyPack = false;
        continue;
      }
      const candidates = pack.summary
        ? pending.filter((o) => pack.summary?.mayContain(o))
        : pending;
      if (candidates.length === 0) continue;
      const found = await pack.idx.lookupMany(candidates);
      const hits = new Set<string>();
      found.forEach((entry, i) => {
        if (!entry) return;
        const hex = oidHex(candidates[i] as Uint8Array);
        hits.add(hex);
        this.#located.set(hex, { pack: index, offset: entry.offset });
      });
      pending = pending.filter((oid) => !hits.has(oidHex(oid)));
    }
    if (everyPack) for (const oid of pending) this.#located.set(oidHex(oid), undefined);
  }

  /** The object, or undefined when no pack of the view holds it. Throws PackError for a bad pack. */
  async readObject(oid: Uint8Array): Promise<StoredObject | undefined> {
    this.#checkOpen();
    const at = await this.#locate(oid);
    if (at === undefined) return undefined;
    const object = await this.#resolve(at, this.#blocks.read);
    this.stats.objectsRead++;
    return { type: object.type, bytes: this.#owned(at, object) };
  }

  /**
   * The object's type and size, or undefined when the view lacks it. A
   * whole object costs one header read. For a delta, the size comes from
   * its delta program (inflated, not applied) and the type from the entry
   * headers down its chain; no base is rebuilt.
   */
  async readHeader(oid: Uint8Array): Promise<ObjectHeaderInfo | undefined> {
    this.#checkOpen();
    const at = await this.#locate(oid);
    if (at === undefined) return undefined;
    const cached = this.#cache.peek(at.pack, at.offset);
    if (cached) return { type: cached.type, size: cached.data.length };
    const max = this.#limits.maxObjectBytes;
    const { header } = await readEntryHeader(this.#blocks.read, this.#pack(at), at.offset, max);
    if (isObjectType(header.kind)) return { type: header.kind, size: header.size };
    // The program is inflated whole, so a large one is reserved first, as in `#resolve`.
    const reservation =
      header.size > DEFAULT_PACK_LIMITS.largeObjectBytes
        ? await reservePackMemory(this.#memory, header.size, "a delta program", at.offset)
        : undefined;
    let size: number;
    try {
      const delta = await readEntry(this.#blocks.read, this.#zlib, this.#pack(at), at.offset, max);
      size = readDeltaHeader(delta.data, max).resultSize;
    } finally {
      reservation?.release();
    }
    let current = await this.#baseOf(at, header);
    for (let depth = 1; ; depth++) {
      if (depth > this.#limits.maxDeltaDepth) throw tooDeep(this.#limits, at.offset);
      const base = this.#cache.peek(current.pack, current.offset);
      if (base) return { type: base.type, size };
      const next = (
        await readEntryHeader(this.#blocks.read, this.#pack(current), current.offset, max)
      ).header;
      if (isObjectType(next.kind)) return { type: next.kind, size };
      current = await this.#baseOf(current, next);
    }
  }

  /**
   * Reads many objects, calling `onObject` for each in pack order (packs in
   * view order, offsets ascending), whatever order `oids` came in; each
   * object once. Every pack is read in large sequential ranges, bypassing
   * the block cache; delta bases outside the current range come through the
   * block cache. Throws MissingObjectError, before reading, when the view
   * lacks any of the oids. Meant for many objects of a pack; a few
   * scattered objects cost less through `readObject`.
   */
  async walk(
    oids: Iterable<Uint8Array>,
    onObject: (object: WalkedObject) => void | Promise<void>,
  ): Promise<void> {
    this.#checkOpen();
    const byPack: { oid: Oid; offset: number }[][] = this.#view.packs.map(() => []);
    const missing: Oid[] = [];
    const seen = new Set<string>();
    for (const oid of oids) {
      const at = await this.#locate(oid);
      if (at === undefined) {
        missing.push(oidFromBytes(oid));
        continue;
      }
      const key = `${at.pack}:${at.offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      byPack[at.pack]?.push({ oid: oidFromBytes(oid), offset: at.offset });
    }
    if (missing.length > 0) throw new MissingObjectError(missing);

    const reservation = await this.#memory.reserve(this.#limits.rangeBytes);
    try {
      for (let pack = 0; pack < byPack.length; pack++) {
        const wanted = (byPack[pack] ?? []).sort((a, b) => a.offset - b.offset);
        if (wanted.length === 0) continue;
        const viewPack = this.#view.packs[pack];
        if (viewPack === undefined) continue;
        const sequential = new SequentialPackReader(
          this.#store,
          viewPack,
          this.#limits.rangeBytes,
          this.stats,
        );
        const forward: PackBytesSource = (_, start, minEnd) => sequential.advance(start, minEnd);
        // Bases: from the range in hand when it covers them, else through the block cache.
        const bases: PackBytesSource = async (p, start, minEnd) =>
          (p === viewPack && sequential.peek(start, minEnd)) || this.#blocks.read(p, start, minEnd);
        for (const { oid, offset } of wanted) {
          this.#checkOpen();
          const at = { pack, offset };
          const object = await this.#resolve(at, bases, forward);
          this.stats.objectsRead++;
          await onObject({ oid, type: object.type, bytes: this.#owned(at, object) });
        }
      }
    } finally {
      reservation.release();
    }
  }

  /**
   * Builds the object at `at`: from the delta-base cache, or by reading its
   * entry and, for a delta, its chain down to a cached or whole base. The
   * chain is found through entry headers first; then its delta programs are
   * inflated and applied bottom up, one at a time (a large one reserved from
   * the memory budget while it is held), so memory does not grow with the
   * chain's depth. The first entry is read through `first`, bases through `source`.
   * Every object built on the way is cached.
   */
  async #resolve(
    at: Location,
    source: PackBytesSource,
    first: PackBytesSource = source,
  ): Promise<CachedObject> {
    const { maxObjectBytes, maxDeltaDepth } = this.#limits;
    const chain: { at: Location; head: EntryHead }[] = [];
    let kept = 0;
    let current = at;
    let base: CachedObject;
    for (;;) {
      const cached = this.#cache.get(current.pack, current.offset);
      if (cached) {
        this.stats.deltaBaseHits++;
        base = cached;
        break;
      }
      this.stats.deltaBaseMisses++;
      const read = chain.length === 0 ? first : source;
      const pack = this.#pack(current);
      const head = await readEntryHead(
        read,
        pack,
        current.offset,
        maxObjectBytes,
        CHAIN_READ_BYTES - kept,
      );
      const { header } = head;
      if (isObjectType(header.kind)) {
        const entry = await readEntry(read, this.#zlib, pack, current.offset, maxObjectBytes, head);
        base = { type: header.kind, data: entry.data };
        this.#cache.put(current.pack, current.offset, base);
        break;
      }
      kept += head.bytes.length;
      chain.push({ at: current, head });
      if (chain.length > maxDeltaDepth) throw tooDeep(this.#limits, at.offset);
      current = await this.#baseOf(current, header);
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      const link = chain[k] as { at: Location; head: EntryHead };
      // A program up to the large-object size rides on the cache's reservation,
      // as in pack parsing; only one is held at a time.
      const size = link.head.header.size;
      const reservation =
        size > DEFAULT_PACK_LIMITS.largeObjectBytes
          ? await reservePackMemory(this.#memory, size, "a delta program", link.at.offset)
          : undefined;
      try {
        const { data: delta } = await readEntry(
          k === 0 ? first : source,
          this.#zlib,
          this.#pack(link.at),
          link.at.offset,
          maxObjectBytes,
          link.head,
        );
        base = { type: base.type, data: this.#apply(base.data, delta, link.at.offset) };
      } finally {
        reservation?.release();
      }
      chain.pop();
      this.#cache.put(link.at.pack, link.at.offset, base);
    }
    return base;
  }

  #apply(base: Uint8Array, delta: Uint8Array, offset: number): Uint8Array {
    try {
      return applyDelta(base, delta, this.#limits.maxObjectBytes);
    } catch (error) {
      if (error instanceof PackError && error.offset === undefined) {
        throw new PackError(error.code, error.detail, offset);
      }
      throw error;
    }
  }

  /** Where a delta's base is: in the same pack (OFS), or by oid in the view, same pack first (REF). */
  async #baseOf(at: Location, header: EntryHeader): Promise<Location> {
    if (header.kind === "ofs-delta") return { pack: at.pack, offset: header.baseOffset };
    if (header.kind !== "ref-delta") throw new Error("not a delta");
    const found = await this.#locate(header.baseOid, at.pack);
    if (found === undefined) {
      throw new PackError(
        "missing-base",
        `delta base ${oidToHex(header.baseOid)} is not in the view`,
        at.offset,
      );
    }
    return found;
  }

  /** The first pack of the view holding `oid` (trying `prefer` first), or undefined. */
  async #locate(oid: Uint8Array, prefer?: number): Promise<Location | undefined> {
    if (oid.length !== OID_BYTES) throw new RangeError(`an oid has ${OID_BYTES} bytes`);
    const { packs } = this.#view;
    // A delta's base is looked for in the delta's own pack first, whatever
    // `prefetch` found: another pack's copy may be a longer delta chain.
    if (prefer !== undefined) {
      const found = await this.#lookupIn(prefer, oid);
      if (found) return found;
    }
    const hex = this.#located.size > 0 ? oidHex(oid) : "";
    if (this.#located.has(hex)) return this.#located.get(hex);
    for (let index = 0; index < packs.length; index++) {
      if (index === prefer) continue;
      const found = await this.#lookupIn(index, oid);
      if (found) return found;
    }
    return undefined;
  }

  async #lookupIn(index: number, oid: Uint8Array): Promise<Location | undefined> {
    const pack = this.#view.packs[index];
    if (pack === undefined || (pack.summary && !pack.summary.mayContain(oid))) return undefined;
    const found = await pack.idx.lookup(oid);
    return found && { pack: index, offset: found.offset };
  }

  #pack(at: Location) {
    const pack = this.#view.packs[at.pack];
    if (pack === undefined) throw new RangeError(`no pack ${at.pack} in the view`);
    return pack;
  }

  /** Bytes the caller may keep and change: a copy when the cache holds the same buffer. */
  #owned(at: Location, object: CachedObject): Uint8Array {
    return this.#cache.peek(at.pack, at.offset) === object ? copyBytes(object.data) : object.data;
  }

  #checkOpen(): void {
    if (this.#released) throw new Error("the object reader was released");
  }
}

function oidHex(oid: Uint8Array): string {
  let hex = "";
  for (const byte of oid) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function tooDeep(limits: ReaderLimits, offset: number): PackError {
  return new PackError("delta-too-deep", `delta chain longer than ${limits.maxDeltaDepth}`, offset);
}

function checkLimits(limits: ReaderLimits): ReaderLimits {
  const check = (name: keyof ReaderLimits, min: number, max: number) => {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(
        `reader limit ${name} must be an integer from ${min} to ${max}, not ${value}`,
      );
    }
  };
  check("maxObjectBytes", 1, 0xffffffff);
  check("maxDeltaDepth", 1, 4095);
  check("deltaBaseCacheBytes", 1, Number.MAX_SAFE_INTEGER);
  check("rangeBytes", 1024, Number.MAX_SAFE_INTEGER);
  return limits;
}
