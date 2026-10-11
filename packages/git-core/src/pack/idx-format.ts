import { OID_BYTES } from "../object/oid.js";

/*
 * Pack index (`.idx`) version 2, as git defines it (Documentation/
 * gitformat-pack.adoc, "Version 2 pack-*.idx files", git v2.53.0, verified):
 *
 *   magic ff 74 4f 63 ("\377tOc"), version 2       8 bytes
 *   fanout: 256 big-endian counts                   1024 bytes
 *   object ids, sorted                              20 × N
 *   CRC32 of each packed entry                      4 × N
 *   31-bit offsets; MSB set = index into next table 4 × N
 *   64-bit offsets (only those ≥ 2^31)              8 × L
 *   pack checksum, then SHA-1 of all of the above   20 + 20
 *
 * git's loader (packfile.c `load_idx`) accepts at most N - 1 large offsets,
 * since a pack's first entry is always at offset 12.
 */

export const IDX_MAGIC = 0xff744f63;
export const IDX_VERSION = 2;
export const IDX_HEADER_BYTES = 8;
export const IDX_FANOUT_ENTRIES = 256;
/** The fanout table's size: the registry keeps a copy of it per pack. */
export const IDX_FANOUT_BYTES = IDX_FANOUT_ENTRIES * 4;
/** Where the sorted oid table starts. */
export const IDX_OIDS_START = IDX_HEADER_BYTES + IDX_FANOUT_BYTES;
export const IDX_CHECKSUM_BYTES = 20;
export const IDX_LARGE_OFFSET_FLAG = 0x80000000;
/** Largest offset stored in the 31-bit table; larger ones go to the 64-bit table. */
export const IDX_MAX_SMALL_OFFSET = 0x7fffffff;
/** An `.idx` with no entries: header, fanout and the two checksums. */
export const IDX_MIN_BYTES = IDX_OIDS_START + 2 * IDX_CHECKSUM_BYTES;

/** Why an `.idx` was rejected. */
export type IdxErrorCode =
  /** Not the v2 magic, or a version other than 2. */
  | "bad-header"
  /** Fanout counts that decrease. */
  | "bad-fanout"
  /** The file length does not fit the entry count. */
  | "bad-size"
  /** Shorter than its header, fanout or tables say, or a short range read. */
  | "truncated"
  /** A large-offset reference outside the table, or a 64-bit offset that is not ≥ 2^31 and ≤ 2^53 - 1. */
  | "bad-large-offset"
  /** The same object twice, when the writer runs in strict mode (git index-pack --strict). */
  | "duplicate-object";

/** An `.idx` the readers rejected, or entries the strict writer refused. */
export class IdxError extends Error {
  readonly code: IdxErrorCode;
  readonly detail: string;
  constructor(code: IdxErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "IdxError";
    this.code = code;
    this.detail = detail;
  }
}

/** Byte positions of the tables in an `.idx` of `count` entries and `largeCount` large offsets. */
export interface IdxLayout {
  readonly count: number;
  readonly largeCount: number;
  readonly oidsAt: number;
  readonly crc32sAt: number;
  readonly offsetsAt: number;
  readonly largeOffsetsAt: number;
  readonly packChecksumAt: number;
  readonly checksumAt: number;
  readonly byteLength: number;
}

export function idxLayout(count: number, largeCount: number): IdxLayout {
  const oidsAt = IDX_OIDS_START;
  const crc32sAt = oidsAt + count * OID_BYTES;
  const offsetsAt = crc32sAt + count * 4;
  const largeOffsetsAt = offsetsAt + count * 4;
  const packChecksumAt = largeOffsetsAt + largeCount * 8;
  const checksumAt = packChecksumAt + IDX_CHECKSUM_BYTES;
  return {
    count,
    largeCount,
    oidsAt,
    crc32sAt,
    offsetsAt,
    largeOffsetsAt,
    packChecksumAt,
    checksumAt,
    byteLength: checksumAt + IDX_CHECKSUM_BYTES,
  };
}

/**
 * Reads the 1 KB fanout (as stored in an `.idx` or the registry) into
 * cumulative counts: `fanout[b]` is the number of oids whose first byte is
 * at most `b`. Throws `IdxError` when the counts decrease.
 */
export function decodeFanout(bytes: Uint8Array, at = 0): Uint32Array {
  if (at < 0 || at + IDX_FANOUT_BYTES > bytes.length) {
    throw new IdxError("truncated", `no ${IDX_FANOUT_BYTES}-byte fanout at ${at}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, IDX_FANOUT_BYTES);
  const fanout = new Uint32Array(IDX_FANOUT_ENTRIES);
  let previous = 0;
  for (let b = 0; b < IDX_FANOUT_ENTRIES; b++) {
    const n = view.getUint32(b * 4);
    if (n < previous) throw new IdxError("bad-fanout", `fanout[${b}] = ${n} < ${previous}`);
    fanout[b] = n;
    previous = n;
  }
  return fanout;
}

/** The fanout as the 1 KB big-endian table an `.idx` (and the registry row) holds. */
export function encodeFanout(fanout: Uint32Array): Uint8Array {
  if (fanout.length !== IDX_FANOUT_ENTRIES) {
    throw new RangeError(`a fanout has ${IDX_FANOUT_ENTRIES} entries, not ${fanout.length}`);
  }
  const bytes = new Uint8Array(IDX_FANOUT_BYTES);
  const view = new DataView(bytes.buffer);
  for (let b = 0; b < IDX_FANOUT_ENTRIES; b++) view.setUint32(b * 4, fanout[b] as number);
  return bytes;
}

/** Positions `[lo, hi)` of the oids whose first byte is `firstByte`. */
export function fanoutBucket(fanout: Uint32Array, firstByte: number): [lo: number, hi: number] {
  const lo = firstByte === 0 ? 0 : (fanout[firstByte - 1] as number);
  return [lo, fanout[firstByte] as number];
}

/**
 * The first index in `[0, n)` of the run of oids equal to the 20 bytes at
 * `keyAt` in `key`, in a table of `n` sorted oids starting at `tableAt` in
 * `table`; or -1. With duplicates, the first copy is returned.
 */
export function searchOids(
  table: Uint8Array,
  tableAt: number,
  n: number,
  key: Uint8Array,
  keyAt: number,
): number {
  let lo = 0;
  let hi = n;
  // Lower bound: first index whose oid is >= key.
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareAt(table, tableAt + mid * OID_BYTES, key, keyAt) < 0) lo = mid + 1;
    else hi = mid;
  }
  if (lo < n && compareAt(table, tableAt + lo * OID_BYTES, key, keyAt) === 0) return lo;
  return -1;
}

/** Bytewise comparison of two 20-byte oids held in larger buffers. */
export function compareAt(a: Uint8Array, aAt: number, b: Uint8Array, bAt: number): number {
  for (let i = 0; i < OID_BYTES; i++) {
    const d = (a[aAt + i] as number) - (b[bAt + i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The 64-bit offset stored at `at`. Throws `IdxError` unless it is at least
 * 2^31 (the writer puts nothing smaller there) and a safe integer.
 */
export function readLargeOffset(view: DataView, at: number): number {
  const high = view.getUint32(at);
  const low = view.getUint32(at + 4);
  const offset = high * 2 ** 32 + low;
  if (offset <= IDX_MAX_SMALL_OFFSET || !Number.isSafeInteger(offset)) {
    throw new IdxError("bad-large-offset", `64-bit offset ${high}:${low} out of range`);
  }
  return offset;
}

/** Checks that `oid` holds a 20-byte object id at `at`. */
export function checkOidAt(oid: Uint8Array, at: number): void {
  if (!Number.isInteger(at) || at < 0 || at + OID_BYTES > oid.length) {
    throw new RangeError(`no ${OID_BYTES}-byte object id at offset ${at}`);
  }
}
