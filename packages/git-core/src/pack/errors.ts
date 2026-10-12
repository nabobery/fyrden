/** Why a pack was rejected. */
export type PackErrorCode =
  /** Not "PACK", or a version other than 2 or 3. */
  | "bad-header"
  /** The header declares more objects than the configured ceiling. */
  | "too-many-objects"
  /** The stream ended inside the header, an entry or the trailer. */
  | "truncated"
  /** Bytes after the trailer. */
  | "trailing-bytes"
  /** The trailer is not the SHA-1 of the pack. */
  | "bad-checksum"
  /** Malformed entry header: unknown type, overlong size or offset encoding. */
  | "bad-entry-header"
  /** An OFS_DELTA base offset that is not the start of an earlier entry. */
  | "bad-delta-base-offset"
  /** A declared object or delta size above the per-object cap. */
  | "object-too-large"
  /** An entry's zlib stream is longer than any encoder would make it. */
  | "compressed-too-large"
  /** An entry inflates to more bytes than its header declares. */
  | "inflate-bomb"
  /** An entry inflates to fewer bytes than its header declares. */
  | "size-mismatch"
  /** An entry's zlib stream is corrupt. */
  | "bad-zlib"
  /** A malformed delta program (bad opcode, copy outside the base, overrun). */
  | "bad-delta"
  /** A delta's declared base size differs from the actual base length. */
  | "delta-base-size-mismatch"
  /** Applying a delta gives a length other than its declared result size. */
  | "delta-result-size-mismatch"
  /** A delta chain deeper than the configured cap. */
  | "delta-too-deep"
  /** Deltas whose base is neither in the pack nor found outside it (or a delta cycle). */
  | "missing-base"
  /** An external base whose bytes do not hash to the oid that was asked for. */
  | "bad-external-base"
  /** Parsing needs more memory than the whole budget holds (a large object or a very large pack). */
  | "exceeds-memory-budget";

/** A pack the parser rejected, or (`bad-checksum`) pack bytes that changed between the two passes. */
export class PackError extends Error {
  readonly code: PackErrorCode;
  /** Offset in the pack of the entry (or byte) at fault, when there is one. */
  readonly offset: number | undefined;
  /** The message without the code and offset. */
  readonly detail: string;
  constructor(code: PackErrorCode, detail: string, offset?: number) {
    super(offset === undefined ? `${code}: ${detail}` : `${code} at offset ${offset}: ${detail}`);
    this.name = "PackError";
    this.code = code;
    this.offset = offset;
    this.detail = detail;
  }
}
