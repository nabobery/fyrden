import { OBJECT_TYPES, type ObjectType } from "../object/object.js";
import { OID_BYTES, type Oid, oidFromBytes } from "../object/oid.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import { ENTRY_TYPE_CODES, type EntryKind } from "./entry-header.js";
import { reservePackMemory } from "./memory.js";

/*
 * Per-entry records of a pack being indexed, in flat typed arrays (one slot
 * per entry, in pack order) rather than one object per entry, so a pack of a
 * million objects costs tens of megabytes, not hundreds. The arrays grow as
 * entries arrive (a header's object count is not trusted for allocation) and
 * every byte they hold is reserved from the `MemoryBudget` first.
 */

/**
 * Bytes per entry: offset 8, header length 1, kind 1, entry size 4, size 4,
 * CRC32 4, base 4, oid 20, object type 1, depth 1. REF_DELTAs add 20 for the
 * base oid.
 */
export const ENTRY_RECORD_BYTES = 48;
const MIN_CAPACITY = 256;
const KIND_BY_CODE: readonly EntryKind[] = (() => {
  const kinds: EntryKind[] = [];
  for (const [kind, code] of Object.entries(ENTRY_TYPE_CODES)) kinds[code] = kind as EntryKind;
  return kinds;
})();

/** Read access to a parsed pack's entries, in pack order. */
export interface PackEntries {
  readonly count: number;
  /** Object ids, 20 bytes per entry. The `.idx` writer sorts by these. */
  readonly oids: Uint8Array;
  readonly offsets: Float64Array;
  readonly crc32s: Uint32Array;
  oid(index: number): Oid;
  /** The object's type (for a delta, the type of the object it rebuilds). */
  type(index: number): ObjectType;
  /** The object's size (for a delta, the size of the rebuilt object). */
  size(index: number): number;
  /** Inflated length of the entry: the object, or for a delta its program (what `git verify-pack -v` prints as size). */
  entrySize(index: number): number;
  offset(index: number): number;
  crc32(index: number): number;
  /** Bytes the entry takes in the pack: header plus zlib stream. */
  entryLength(index: number): number;
  /** How the entry is stored. */
  kind(index: number): EntryKind;
  /** Delta chain length: 0 for a whole object, 1 for a delta against one. */
  depth(index: number): number;
  /** The id of the delta base, or undefined for a whole object. */
  baseOid(index: number): Oid | undefined;
}

export interface NewEntry {
  readonly offset: number;
  readonly headerLength: number;
  readonly kind: EntryKind;
  /** Inflated length: the object, or the delta program. */
  readonly entrySize: number;
  /** Object size: the entry size, or a delta's declared result size. */
  readonly size: number;
  readonly crc32: number;
  /** Entry index of an OFS_DELTA base, or the base oid of a REF_DELTA. */
  readonly base?: number | Uint8Array | undefined;
  /** Id and type, for whole objects. */
  readonly oid?: Uint8Array;
}

export class PackIndexState implements PackEntries {
  readonly #memory: MemoryBudget;
  readonly #maxCount: number;
  #reservation: MemoryReservation | undefined;
  #refReservation: MemoryReservation | undefined;
  #capacity = 0;
  #count = 0;
  #refCount = 0;
  #dataEnd = 0;

  offsets = new Float64Array(0);
  #headerLengths = new Uint8Array(0);
  #kinds = new Uint8Array(0);
  #entrySizes = new Uint32Array(0);
  #sizes = new Uint32Array(0);
  crc32s = new Uint32Array(0);
  #bases = new Uint32Array(0);
  oids = new Uint8Array(0);
  #types = new Uint8Array(0);
  #depths = new Uint8Array(0);
  #refBaseOids = new Uint8Array(0);

  /** `maxCount` is the header's object count: the arrays never grow past it. */
  constructor(memory: MemoryBudget, maxCount: number) {
    this.#memory = memory;
    this.#maxCount = maxCount;
  }

  get count(): number {
    return this.#count;
  }

  /** Appends an entry and returns its index. */
  async add(entry: NewEntry): Promise<number> {
    if (this.#count === this.#capacity) await this.#grow();
    const i = this.#count++;
    this.offsets[i] = entry.offset;
    this.#headerLengths[i] = entry.headerLength;
    this.#kinds[i] = ENTRY_TYPE_CODES[entry.kind];
    this.#entrySizes[i] = entry.entrySize;
    this.#sizes[i] = entry.size;
    this.crc32s[i] = entry.crc32;
    if (typeof entry.base === "number") {
      this.#bases[i] = entry.base;
    } else if (entry.base !== undefined) {
      this.#bases[i] = await this.#addRefBase(entry.base);
    }
    if (entry.oid !== undefined) {
      this.oids.set(entry.oid, i * OID_BYTES);
      this.#types[i] = ENTRY_TYPE_CODES[entry.kind as ObjectType];
    }
    return i;
  }

  /** Records the result of resolving a delta. */
  resolve(index: number, oid: Uint8Array, type: ObjectType, depth: number): void {
    this.oids.set(oid, index * OID_BYTES);
    this.#types[index] = ENTRY_TYPE_CODES[type];
    this.#depths[index] = depth;
  }

  isResolved(index: number): boolean {
    return this.#types[index] !== 0;
  }

  /** Marks where the last entry ends (the trailer's offset). */
  finish(dataEnd: number): void {
    this.#dataEnd = dataEnd;
  }

  /** The entry starting exactly at `offset`, or -1. Offsets are ascending. */
  findOffset(offset: number): number {
    let lo = 0;
    let hi = this.#count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.offsets[mid] as number;
      if (at === offset) return mid;
      if (at < offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  oid(index: number): Oid {
    return oidFromBytes(this.oids, index * OID_BYTES);
  }

  type(index: number): ObjectType {
    const code = this.#types[index] as number;
    if (code === 0) throw new RangeError(`entry ${index} is not resolved`);
    return OBJECT_TYPES[code - 1] as ObjectType;
  }

  size(index: number): number {
    return this.#sizes[index] as number;
  }

  offset(index: number): number {
    return this.offsets[index] as number;
  }

  crc32(index: number): number {
    return this.crc32s[index] as number;
  }

  kind(index: number): EntryKind {
    return KIND_BY_CODE[this.#kinds[index] as number] as EntryKind;
  }

  /** Inflated length of the entry's zlib stream (a delta's program length). */
  entrySize(index: number): number {
    return this.#entrySizes[index] as number;
  }

  headerLength(index: number): number {
    return this.#headerLengths[index] as number;
  }

  entryEnd(index: number): number {
    return index + 1 < this.#count ? (this.offsets[index + 1] as number) : this.#dataEnd;
  }

  entryLength(index: number): number {
    return this.entryEnd(index) - (this.offsets[index] as number);
  }

  depth(index: number): number {
    return this.#depths[index] as number;
  }

  /** Entry index of an OFS_DELTA's base. */
  ofsBase(index: number): number {
    return this.#bases[index] as number;
  }

  /** Offset into `refBaseOids` of a REF_DELTA's base oid. */
  refBaseAt(index: number): number {
    return (this.#bases[index] as number) * OID_BYTES;
  }

  get refBaseOids(): Uint8Array {
    return this.#refBaseOids;
  }

  baseOid(index: number): Oid | undefined {
    const kind = this.kind(index);
    if (kind === "ofs-delta") return this.oid(this.ofsBase(index));
    if (kind === "ref-delta") return oidFromBytes(this.#refBaseOids, this.refBaseAt(index));
    return undefined;
  }

  /** Returns the arrays' bytes to the memory budget. */
  release(): void {
    this.#reservation?.release();
    this.#refReservation?.release();
  }

  async #grow(): Promise<void> {
    const capacity = Math.min(Math.max(this.#capacity * 2, MIN_CAPACITY), this.#maxCount);
    const reservation = await reservePackMemory(
      this.#memory,
      capacity * ENTRY_RECORD_BYTES,
      `records for ${capacity} entries`,
    );
    const grow = <T extends Float64Array | Uint32Array | Uint8Array>(
      old: T,
      make: (n: number) => T,
      width = 1,
    ): T => {
      const next = make(capacity * width);
      next.set(old as never);
      return next;
    };
    this.offsets = grow(this.offsets, (n) => new Float64Array(n));
    this.#headerLengths = grow(this.#headerLengths, (n) => new Uint8Array(n));
    this.#kinds = grow(this.#kinds, (n) => new Uint8Array(n));
    this.#entrySizes = grow(this.#entrySizes, (n) => new Uint32Array(n));
    this.#sizes = grow(this.#sizes, (n) => new Uint32Array(n));
    this.crc32s = grow(this.crc32s, (n) => new Uint32Array(n));
    this.#bases = grow(this.#bases, (n) => new Uint32Array(n));
    this.oids = grow(this.oids, (n) => new Uint8Array(n), OID_BYTES);
    this.#types = grow(this.#types, (n) => new Uint8Array(n));
    this.#depths = grow(this.#depths, (n) => new Uint8Array(n));
    this.#reservation?.release();
    this.#reservation = reservation;
    this.#capacity = capacity;
  }

  async #addRefBase(oid: Uint8Array): Promise<number> {
    const slot = this.#refCount;
    if ((slot + 1) * OID_BYTES > this.#refBaseOids.length) {
      const slots = Math.min(Math.max(slot * 2, MIN_CAPACITY), this.#maxCount);
      const reservation = await reservePackMemory(
        this.#memory,
        slots * OID_BYTES,
        `base ids for ${slots} deltas`,
      );
      const next = new Uint8Array(slots * OID_BYTES);
      next.set(this.#refBaseOids);
      this.#refBaseOids = next;
      this.#refReservation?.release();
      this.#refReservation = reservation;
    }
    this.#refBaseOids.set(oid.subarray(0, OID_BYTES), slot * OID_BYTES);
    this.#refCount++;
    return slot;
  }
}
