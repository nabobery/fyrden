import { OID_BYTES, type Oid, oidFromBytes } from "../object/oid.js";
import type { HasherFactory } from "../ports/hasher.js";
import {
  checkOidAt,
  decodeFanout,
  fanoutBucket,
  IDX_CHECKSUM_BYTES,
  IDX_HEADER_BYTES,
  IDX_LARGE_OFFSET_FLAG,
  IDX_MAGIC,
  IDX_VERSION,
  IdxError,
  type IdxLayout,
  idxLayout,
  readLargeOffset,
  searchOids,
} from "./idx-format.js";

/** One `.idx` entry: its position in oid order, pack offset and CRC32. */
export interface IdxLookup {
  readonly position: number;
  readonly offset: number;
  readonly crc32: number;
}

/**
 * Counts the reads an `.idx` read by ranges makes for one caller, and
 * bounds its batched lookups. An index held in memory reads nothing.
 */
export interface IdxReadBudget {
  /** Reads made so far: the index adds one for each read it makes. */
  reads: number;
  /**
   * A batched lookup starts no read that could take `reads` past this;
   * the oids it could not answer come back `null`. Single lookups only
   * count their reads.
   */
  readonly maxReads: number;
}

export interface IdxEntry extends IdxLookup {
  readonly oid: Oid;
}

/**
 * A version 2 `.idx` held whole in memory. `parse` checks the header, the
 * fanout and that the length fits the entry count (as git's `load_idx`);
 * the trailing checksum is checked only by `verifyChecksum`. Lookups
 * narrow by the fanout and binary-search the bucket; with duplicate oids
 * they return the first copy (the lowest offset, for idx files this
 * package writes).
 */
export class PackIdx {
  readonly count: number;
  /** Cumulative counts per first oid byte. */
  readonly fanout: Uint32Array;
  readonly largeOffsetCount: number;
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #layout: IdxLayout;

  private constructor(bytes: Uint8Array, fanout: Uint32Array, layout: IdxLayout) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.fanout = fanout;
    this.count = layout.count;
    this.largeOffsetCount = layout.largeCount;
    this.#layout = layout;
  }

  /** Reads an `.idx` without copying it. Throws `IdxError` for a malformed one. */
  static parse(bytes: Uint8Array): PackIdx {
    const fanout = readIdxHeader(bytes);
    return new PackIdx(bytes, fanout, layoutForLength(fanout, bytes.length));
  }

  /** The checksum of the pack this index describes. */
  packChecksum(): Uint8Array {
    const at = this.#layout.packChecksumAt;
    return this.#bytes.slice(at, at + IDX_CHECKSUM_BYTES);
  }

  /** The trailing checksum of the `.idx` itself. */
  checksum(): Uint8Array {
    const at = this.#layout.checksumAt;
    return this.#bytes.slice(at, at + IDX_CHECKSUM_BYTES);
  }

  /** Whether the trailing checksum is the SHA-1 of everything before it. */
  async verifyChecksum(createHasher: HasherFactory): Promise<boolean> {
    const hasher = createHasher();
    await hasher.update(this.#bytes.subarray(0, this.#layout.checksumAt));
    const digest = await hasher.digest();
    const stored = this.#bytes.subarray(this.#layout.checksumAt);
    return digest.every((byte, i) => byte === stored[i]);
  }

  /** The sorted oid table, 20 bytes per entry, without copying. */
  oidTable(): Uint8Array {
    const at = this.#layout.oidsAt;
    return this.#bytes.subarray(at, at + this.count * OID_BYTES);
  }

  /** The position of the 20 bytes at `at` in `oid` (first copy), or -1. */
  find(oid: Uint8Array, at = 0): number {
    checkOidAt(oid, at);
    const [lo, hi] = fanoutBucket(this.fanout, oid[at] as number);
    const found = searchOids(this.#bytes, this.#layout.oidsAt + lo * OID_BYTES, hi - lo, oid, at);
    return found < 0 ? -1 : lo + found;
  }

  /**
   * `find` as a free function over packed oid bytes, the shape
   * `markPositions` takes to fill a reachability bitset by `.idx` position.
   */
  readonly positionOf = (oids: Uint8Array, offset: number): number => this.find(oids, offset);

  lookup(oid: Uint8Array, at = 0): IdxLookup | undefined {
    const position = this.find(oid, at);
    if (position < 0) return undefined;
    return { position, offset: this.offsetAt(position), crc32: this.crc32At(position) };
  }

  /** `lookup` for each oid (the batched form `RangedPackIdx` has, for the same callers). */
  lookupMany(oids: readonly Uint8Array[]): (IdxLookup | undefined)[] {
    return oids.map((oid) => this.lookup(oid));
  }

  oidAt(position: number): Oid {
    this.#checkPosition(position);
    return oidFromBytes(this.#bytes, this.#layout.oidsAt + position * OID_BYTES);
  }

  crc32At(position: number): number {
    this.#checkPosition(position);
    return this.#view.getUint32(this.#layout.crc32sAt + position * 4);
  }

  /** The entry's pack offset. Throws `IdxError` for a bad large-offset reference. */
  offsetAt(position: number): number {
    this.#checkPosition(position);
    const small = this.#view.getUint32(this.#layout.offsetsAt + position * 4);
    if ((small & IDX_LARGE_OFFSET_FLAG) === 0) return small;
    const index = small & ~IDX_LARGE_OFFSET_FLAG;
    if (index >= this.#layout.largeCount) {
      throw new IdxError(
        "bad-large-offset",
        `entry ${position} refers to large offset ${index} of ${this.#layout.largeCount}`,
      );
    }
    return readLargeOffset(this.#view, this.#layout.largeOffsetsAt + index * 8);
  }

  /** Every entry, in position (oid) order. */
  *entries(): IterableIterator<IdxEntry> {
    for (let position = 0; position < this.count; position++) {
      yield {
        position,
        oid: this.oidAt(position),
        offset: this.offsetAt(position),
        crc32: this.crc32At(position),
      };
    }
  }

  #checkPosition(position: number): void {
    if (!Number.isInteger(position) || position < 0 || position >= this.count) {
      throw new RangeError(`position ${position} is outside 0..${this.count - 1}`);
    }
  }
}

/**
 * Checks the magic and version and reads the fanout from the first
 * 1032 bytes of an `.idx`. Throws `IdxError`.
 */
export function readIdxHeader(bytes: Uint8Array): Uint32Array {
  if (bytes.length < IDX_HEADER_BYTES) {
    throw new IdxError("truncated", `${bytes.length} bytes is shorter than the idx header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== IDX_MAGIC) throw new IdxError("bad-header", "not a v2 pack index");
  const version = view.getUint32(4);
  if (version !== IDX_VERSION) {
    throw new IdxError("bad-header", `index version ${version} is not supported`);
  }
  return decodeFanout(bytes, IDX_HEADER_BYTES);
}

/**
 * The layout of an `.idx` of `byteLength` bytes with this fanout: the
 * length must leave room for 0 to N - 1 whole 8-byte large offsets
 * (git's `load_idx` allows the same range).
 */
export function layoutForLength(fanout: Uint32Array, byteLength: number): IdxLayout {
  const count = fanout[255] as number;
  const base = idxLayout(count, 0).byteLength;
  if (byteLength < base) {
    throw new IdxError("truncated", `${count} entries need ${base} bytes, not ${byteLength}`);
  }
  const extra = byteLength - base;
  const largeCount = extra / 8;
  if (!Number.isInteger(largeCount) || largeCount > Math.max(count - 1, 0)) {
    throw new IdxError("bad-size", `${byteLength} bytes does not fit ${count} entries`);
  }
  return idxLayout(count, largeCount);
}
