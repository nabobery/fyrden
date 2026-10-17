import { OID_BYTES, type Oid, oidFromBytes } from "../object/oid.js";
import {
  checkOidAt,
  fanoutBucket,
  IDX_FANOUT_ENTRIES,
  IDX_LARGE_OFFSET_FLAG,
  IDX_OIDS_START,
  IdxError,
  type IdxLayout,
  idxLayout,
  readLargeOffset,
  searchOids,
} from "./idx-format.js";
import {
  type IdxLocation,
  type IdxReadBudget,
  layoutForLength,
  readIdxHeader,
} from "./idx-read.js";

/**
 * Reads `length` bytes at `offset` of an `.idx` (an R2 range GET, usually
 * through the block cache). May return fewer bytes only at the end of the file.
 */
export type IdxRangeReader = (offset: number, length: number) => Promise<Uint8Array>;

export interface OpenRangedIdxOptions {
  /**
   * The fanout kept in the registry row. With it, opening reads nothing;
   * without it, the header and fanout are read (one 1,032-byte read).
   */
  readonly fanout?: Uint32Array;
  /**
   * The `.idx` length, when known: then large-offset references are
   * bounds-checked against the table. Without it, a reference past the
   * table reads other bytes, which `readLargeOffset` rejects unless they
   * happen to form an offset of at least 2^31.
   */
  readonly byteLength?: number;
}

/**
 * Opens an `.idx` for lookups by range reads, so a large index in R2 is not
 * fetched whole (design: fanout in memory, then only the needed slice of the
 * oid table). Costs per lookup: none when the oid's fanout bucket is empty;
 * otherwise one read of the bucket's oids (20 bytes × bucket size, about
 * 78 KB for a million-object pack), then one read for the offset, plus one
 * more for a 64-bit offset.
 */
export async function openRangedIdx(
  readRange: IdxRangeReader,
  options: OpenRangedIdxOptions = {},
): Promise<RangedPackIdx> {
  const fanout = options.fanout ?? readIdxHeader(await readExactly(readRange, 0, IDX_OIDS_START));
  return RangedPackIdx.withFanout(readRange, fanout, options.byteLength);
}

export class RangedPackIdx {
  readonly count: number;
  readonly fanout: Uint32Array;
  readonly #read: IdxRangeReader;
  readonly #layout: IdxLayout;

  private constructor(readRange: IdxRangeReader, fanout: Uint32Array, layout: IdxLayout) {
    this.#read = readRange;
    this.fanout = fanout;
    this.count = layout.count;
    this.#layout = layout;
  }

  /**
   * Opens with a fanout already in memory (the registry's copy): no read.
   * See `OpenRangedIdxOptions` for `byteLength`.
   */
  static withFanout(
    readRange: IdxRangeReader,
    fanout: Uint32Array,
    byteLength?: number,
  ): RangedPackIdx {
    if (fanout.length !== IDX_FANOUT_ENTRIES) {
      throw new RangeError(`a fanout has ${IDX_FANOUT_ENTRIES} entries, not ${fanout.length}`);
    }
    for (let b = 1; b < IDX_FANOUT_ENTRIES; b++) {
      if ((fanout[b] as number) < (fanout[b - 1] as number)) {
        throw new IdxError("bad-fanout", `fanout[${b}] decreases`);
      }
    }
    const layout =
      byteLength === undefined
        ? idxLayout(fanout[255] as number, Number.POSITIVE_INFINITY)
        : layoutForLength(fanout, byteLength);
    return new RangedPackIdx(readRange, fanout, layout);
  }

  /** The position of the 20 bytes at `at` in `oid` (first copy), or -1. */
  find(oid: Uint8Array, at = 0): Promise<number> {
    return this.#find(this.#read, oid, at);
  }

  async #find(read: IdxRangeReader, oid: Uint8Array, at: number): Promise<number> {
    checkOidAt(oid, at);
    const [lo, hi] = fanoutBucket(this.fanout, oid[at] as number);
    if (lo === hi) return -1;
    const slice = await readExactly(
      read,
      this.#layout.oidsAt + lo * OID_BYTES,
      (hi - lo) * OID_BYTES,
    );
    const found = searchOids(slice, 0, hi - lo, oid, at);
    return found < 0 ? -1 : lo + found;
  }

  /**
   * One oid's entry, without its CRC32 (`crc32At` reads that); its reads
   * are added to `budget` when given.
   */
  async lookup(oid: Uint8Array, at = 0, budget?: IdxReadBudget): Promise<IdxLocation | undefined> {
    const read = counted(this.#read, budget);
    const position = await this.#find(read, oid, at);
    if (position < 0) return undefined;
    return { position, offset: await this.#offsetAt(read, position) };
  }

  /**
   * `lookup` for many oids with coalesced reads: the oid-table slices of
   * their fanout buckets, then the offsets of the entries found, each table
   * read in spans of at most `maxSpanBytes` (one read per table for a small
   * index, instead of two per oid). A bucket larger than the span is still
   * read whole, as `find` reads it; 64-bit offsets are read one by one.
   *
   * With a budget, an oid-table span is read only while its read and the
   * offset reads its entries could need still fit in `budget.maxReads`, and
   * a 64-bit offset only while its read fits; the oids left unanswered are
   * `null`, the others are answered as without it.
   */
  async lookupMany(
    oids: readonly Uint8Array[],
    budget?: IdxReadBudget,
    maxSpanBytes = DEFAULT_SPAN_BYTES,
  ): Promise<(IdxLocation | undefined | null)[]> {
    const read = counted(this.#read, budget);
    const maxReads = budget?.maxReads ?? Number.POSITIVE_INFINITY;
    const spent = () => budget?.reads ?? 0;
    const positions = new Array<number>(oids.length).fill(-1);
    const answered = new Array<boolean>(oids.length).fill(false);
    const byBucket = new Map<number, number[]>();
    for (const [i, oid] of oids.entries()) {
      checkOidAt(oid, 0);
      const first = oid[0] as number;
      const list = byBucket.get(first);
      if (list) list.push(i);
      else byBucket.set(first, [i]);
    }
    const buckets = [...byBucket.keys()]
      .sort((a, b) => a - b)
      .map((first) => {
        const [lo, hi] = fanoutBucket(this.fanout, first);
        return { lo, hi, items: byBucket.get(first) as number[] };
      });
    // An empty bucket answers without a read.
    for (const bucket of buckets) {
      if (bucket.hi === bucket.lo) for (const i of bucket.items) answered[i] = true;
    }
    // Entries per offset read, and the reads still owed for the spans read so far.
    const wordsPerRead = Math.max(1, Math.floor(maxSpanBytes / 4));
    let owed = 0;
    const spans = coalesce(
      buckets.filter((bucket) => bucket.hi > bucket.lo),
      OID_BYTES,
      maxSpanBytes,
    );
    for (const span of spans) {
      // The entries found in one span need at most this many offset reads.
      const words = Math.ceil((span.hi - span.lo) / wordsPerRead);
      if (spent() + owed + 1 + words > maxReads) break;
      owed += words;
      const slice = await readExactly(
        read,
        this.#layout.oidsAt + span.lo * OID_BYTES,
        (span.hi - span.lo) * OID_BYTES,
      );
      for (const bucket of span.members) {
        const at = (bucket.lo - span.lo) * OID_BYTES;
        for (const i of bucket.items) {
          const found = searchOids(slice, at, bucket.hi - bucket.lo, oids[i] as Uint8Array, 0);
          if (found >= 0) positions[i] = bucket.lo + found;
          answered[i] = true;
        }
      }
    }
    const found = [...new Set(positions.filter((p) => p >= 0))].sort((a, b) => a - b);
    const smalls = await this.#readWords(read, this.#layout.offsetsAt, found, maxSpanBytes);
    const offsets = new Map<number, number>();
    for (const position of found) {
      const small = smalls.get(position) as number;
      if ((small & IDX_LARGE_OFFSET_FLAG) === 0) offsets.set(position, small);
      else if (spent() + 1 <= maxReads) {
        offsets.set(position, await this.#largeOffset(read, position, small));
      }
    }
    return positions.map((position, i) => {
      if (!answered[i]) return null;
      if (position < 0) return undefined;
      const offset = offsets.get(position);
      if (offset === undefined) return null;
      return { position, offset };
    });
  }

  /** The 32-bit words at `positions` (ascending) of the table at `tableAt`, read in coalesced spans. */
  async #readWords(
    read: IdxRangeReader,
    tableAt: number,
    positions: readonly number[],
    maxSpanBytes: number,
  ): Promise<Map<number, number>> {
    const words = new Map<number, number>();
    const items = positions.map((p) => ({ lo: p, hi: p + 1, items: [p] }));
    for (const span of coalesce(items, 4, maxSpanBytes)) {
      const bytes = await readExactly(read, tableAt + span.lo * 4, (span.hi - span.lo) * 4);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const item of span.members) words.set(item.lo, view.getUint32((item.lo - span.lo) * 4));
    }
    return words;
  }

  async oidAt(position: number): Promise<Oid> {
    this.#checkPosition(position);
    const at = this.#layout.oidsAt + position * OID_BYTES;
    return oidFromBytes(await readExactly(this.#read, at, OID_BYTES));
  }

  /** The entry's CRC32; its read is added to `budget` when given. */
  async crc32At(position: number, budget?: IdxReadBudget): Promise<number> {
    this.#checkPosition(position);
    return readUint32(counted(this.#read, budget), this.#layout.crc32sAt + position * 4);
  }

  /** The entry's pack offset. Throws `IdxError` for a bad large-offset reference. */
  offsetAt(position: number): Promise<number> {
    return this.#offsetAt(this.#read, position);
  }

  async #offsetAt(read: IdxRangeReader, position: number): Promise<number> {
    this.#checkPosition(position);
    const small = await readUint32(read, this.#layout.offsetsAt + position * 4);
    if ((small & IDX_LARGE_OFFSET_FLAG) === 0) return small;
    return this.#largeOffset(read, position, small);
  }

  /** The 64-bit offset a small offset with the flag refers to. */
  async #largeOffset(read: IdxRangeReader, position: number, small: number): Promise<number> {
    const index = small & ~IDX_LARGE_OFFSET_FLAG;
    if (index >= this.#layout.largeCount) {
      throw new IdxError(
        "bad-large-offset",
        `entry ${position} refers to large offset ${index} of ${this.#layout.largeCount}`,
      );
    }
    const bytes = await readExactly(read, this.#layout.largeOffsetsAt + index * 8, 8);
    return readLargeOffset(new DataView(bytes.buffer, bytes.byteOffset, 8), 0);
  }

  #checkPosition(position: number): void {
    if (!Number.isInteger(position) || position < 0 || position >= this.count) {
      throw new RangeError(`position ${position} is outside 0..${this.count - 1}`);
    }
  }
}

/** Coalesced reads of `lookupMany`: Proposed 1 MiB per read. */
const DEFAULT_SPAN_BYTES = 1024 * 1024;

interface Run<T> {
  readonly lo: number;
  readonly hi: number;
  readonly members: T[];
}

/**
 * Groups ranges `[lo, hi)` of a table (ascending, not overlapping) into
 * runs read with one call each: a range joins the run while the run stays
 * within `maxSpanBytes` (gaps between ranges are read too). A range larger
 * than that is a run of its own.
 */
function coalesce<T extends { readonly lo: number; readonly hi: number }>(
  ranges: readonly T[],
  unitBytes: number,
  maxSpanBytes: number,
): Run<T>[] {
  const runs: Run<T>[] = [];
  let current: { lo: number; hi: number; members: T[] } | undefined;
  for (const range of ranges) {
    if (current && (range.hi - current.lo) * unitBytes <= maxSpanBytes) {
      current.hi = range.hi;
      current.members.push(range);
      continue;
    }
    current = { lo: range.lo, hi: range.hi, members: [range] };
    runs.push(current);
  }
  return runs;
}

/** `read`, adding each read to `budget` when given. */
function counted(read: IdxRangeReader, budget: IdxReadBudget | undefined): IdxRangeReader {
  if (!budget) return read;
  return (offset, length) => {
    budget.reads++;
    return read(offset, length);
  };
}

async function readExactly(
  read: IdxRangeReader,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const bytes = await read(offset, length);
  if (bytes.length !== length) {
    throw new IdxError(
      "truncated",
      `read of ${length} bytes at ${offset} returned ${bytes.length}`,
    );
  }
  return bytes;
}

async function readUint32(read: IdxRangeReader, offset: number): Promise<number> {
  const bytes = await readExactly(read, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
}
