import { OID_BYTES } from "../object/oid.js";
import { checkOidAt } from "./idx-format.js";

/*
 * A bloom filter over a pack's oids, so "may this pack hold X?" is answered
 * from memory and the `.idx` in R2 is read only on a "maybe".
 *
 * No hashing is done: oids are SHA-1 outputs and already uniform, so two
 * 32-bit words of the oid itself (bytes 4–7 and 8–11, independent of the
 * first byte the fanout uses) seed double hashing, h1 + i·h2 mod m
 * (Kirsch and Mitzenmacher, "Less hashing, same performance", 2006). A
 * client can grind objects whose oids hit chosen bits; that only raises
 * the false-positive rate of packs it pushed, which costs extra `.idx`
 * reads, never a wrong answer.
 *
 * Stored form, version 1 (all big-endian):
 *   version (1) | hash count k (1) | reserved, zero (2) |
 *   oids added (4) | bit array length in bytes (4) | bit array
 * split into rows of at most `MAX_FILTER_CHUNK_BYTES`.
 */

export const EXISTENCE_FILTER_VERSION = 1;
export const EXISTENCE_FILTER_HEADER_BYTES = 12;
/** Proposed default: 1% false positives, about 1.2 MB per million oids; tuned under load. */
export const DEFAULT_FALSE_POSITIVE_RATE = 0.01;
/**
 * Largest stored row. Proposed: 1.5 MiB, under the 2 MB Durable Object
 * SQLite row and BLOB limit (verified:
 * developers.cloudflare.com/durable-objects/platform/limits/).
 */
export const MAX_FILTER_CHUNK_BYTES = 1.5 * 1024 * 1024;
/** 2^29 bytes = 2^32 bits, so bit indexes stay below 2^32. */
const MAX_FILTER_BYTES = 2 ** 29;
const MAX_HASHES = 32;

export type ExistenceFilterErrorCode =
  /** A version this code does not read. */
  | "bad-version"
  /** A hash count or reserved field out of range. */
  | "bad-header"
  /** Fewer or more bytes than the header says (a row missing or extra). */
  | "bad-length";

/** Stored filter bytes that cannot be read. */
export class ExistenceFilterError extends Error {
  readonly code: ExistenceFilterErrorCode;
  constructor(code: ExistenceFilterErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ExistenceFilterError";
    this.code = code;
  }
}

export class OidBloomFilter {
  /** Hash functions per oid (k). */
  readonly hashCount: number;
  /** Bits in the filter (m). */
  readonly bitCount: number;
  readonly #bits: Uint8Array;
  #count: number;

  private constructor(hashCount: number, bits: Uint8Array, count: number) {
    this.hashCount = hashCount;
    this.#bits = bits;
    this.bitCount = bits.length * 8;
    this.#count = count;
  }

  /**
   * A filter sized for `expectedCount` oids at `falsePositiveRate`:
   * m = -n·ln p / (ln 2)² bits and k = round(-log2 p) hashes (7 at 1%).
   */
  static create(
    expectedCount: number,
    falsePositiveRate = DEFAULT_FALSE_POSITIVE_RATE,
  ): OidBloomFilter {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
      throw new RangeError(`expected count must be a non-negative integer, not ${expectedCount}`);
    }
    if (!(falsePositiveRate > 0 && falsePositiveRate < 1)) {
      throw new RangeError(`false positive rate must be between 0 and 1, not ${falsePositiveRate}`);
    }
    const hashCount = Math.min(MAX_HASHES, Math.max(1, Math.round(-Math.log2(falsePositiveRate))));
    const bits = Math.ceil((-expectedCount * Math.log(falsePositiveRate)) / Math.LN2 ** 2);
    const bytes = Math.max(8, Math.ceil(bits / 8));
    if (bytes > MAX_FILTER_BYTES) {
      throw new RangeError(`a filter for ${expectedCount} oids exceeds ${MAX_FILTER_BYTES} bytes`);
    }
    return new OidBloomFilter(hashCount, new Uint8Array(bytes), 0);
  }

  /** Oids added so far. */
  get count(): number {
    return this.#count;
  }

  /** Adds the 20-byte oid at `at` in `oid`. */
  add(oid: Uint8Array, at = 0): void {
    checkOidAt(oid, at);
    const m = this.bitCount;
    let index = readWord(oid, at + 4) % m;
    const step = readWord(oid, at + 8) % m;
    for (let i = 0; i < this.hashCount; i++) {
      this.#bits[index >>> 3] = (this.#bits[index >>> 3] as number) | (1 << (index & 7));
      index += step;
      if (index >= m) index -= m;
    }
    this.#count++;
  }

  /** Adds `count` oids packed 20 bytes each (e.g. an `.idx` oid table). */
  addAll(oids: Uint8Array, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count * OID_BYTES > oids.length) {
      throw new RangeError(`no ${count} oids in ${oids.length} bytes`);
    }
    for (let i = 0; i < count; i++) this.add(oids, i * OID_BYTES);
  }

  /** False when the oid at `at` is certainly absent; true when it may be present. */
  mayContain(oid: Uint8Array, at = 0): boolean {
    checkOidAt(oid, at);
    const m = this.bitCount;
    let index = readWord(oid, at + 4) % m;
    const step = readWord(oid, at + 8) % m;
    for (let i = 0; i < this.hashCount; i++) {
      if (((this.#bits[index >>> 3] as number) & (1 << (index & 7))) === 0) return false;
      index += step;
      if (index >= m) index -= m;
    }
    return true;
  }

  /** The stored form: header and bit array. */
  serialize(): Uint8Array {
    const out = new Uint8Array(EXISTENCE_FILTER_HEADER_BYTES + this.#bits.length);
    const view = new DataView(out.buffer);
    view.setUint8(0, EXISTENCE_FILTER_VERSION);
    view.setUint8(1, this.hashCount);
    view.setUint32(4, Math.min(this.#count, 0xffffffff));
    view.setUint32(8, this.#bits.length);
    out.set(this.#bits, EXISTENCE_FILTER_HEADER_BYTES);
    return out;
  }

  /** The stored form split into rows of at most `maxChunkBytes`, in order. */
  toChunks(maxChunkBytes = MAX_FILTER_CHUNK_BYTES): Uint8Array[] {
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) {
      throw new RangeError(`chunk size must be a positive integer, not ${maxChunkBytes}`);
    }
    const bytes = this.serialize();
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += maxChunkBytes) {
      chunks.push(bytes.slice(at, at + maxChunkBytes));
    }
    return chunks;
  }

  /** Reads the stored form. Throws `ExistenceFilterError`. */
  static deserialize(bytes: Uint8Array): OidBloomFilter {
    if (bytes.length < EXISTENCE_FILTER_HEADER_BYTES) {
      throw new ExistenceFilterError(
        "bad-length",
        `${bytes.length} bytes is shorter than the header`,
      );
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(0);
    if (version !== EXISTENCE_FILTER_VERSION) {
      throw new ExistenceFilterError("bad-version", `filter version ${version} is not supported`);
    }
    const hashCount = view.getUint8(1);
    if (hashCount < 1 || hashCount > MAX_HASHES || view.getUint16(2) !== 0) {
      throw new ExistenceFilterError(
        "bad-header",
        `hash count ${hashCount} or reserved bits invalid`,
      );
    }
    const count = view.getUint32(4);
    const length = view.getUint32(8);
    if (length < 8 || length > MAX_FILTER_BYTES) {
      throw new ExistenceFilterError("bad-header", `bit array of ${length} bytes`);
    }
    if (bytes.length !== EXISTENCE_FILTER_HEADER_BYTES + length) {
      throw new ExistenceFilterError(
        "bad-length",
        `header says ${length} bytes of bits, found ${bytes.length - EXISTENCE_FILTER_HEADER_BYTES}`,
      );
    }
    return new OidBloomFilter(hashCount, bytes.slice(EXISTENCE_FILTER_HEADER_BYTES), count);
  }

  /** Reads the stored form from its rows, in chunk order. Throws `ExistenceFilterError`. */
  static fromChunks(chunks: readonly Uint8Array[]): OidBloomFilter {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return OidBloomFilter.deserialize(bytes);
  }
}

function readWord(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] as number) << 24) |
      ((bytes[at + 1] as number) << 16) |
      ((bytes[at + 2] as number) << 8) |
      (bytes[at + 3] as number)) >>>
    0
  );
}
