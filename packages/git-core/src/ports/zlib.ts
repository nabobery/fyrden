/** Why an inflate failed. */
export type ZlibErrorKind =
  /** The input ended before the zlib stream did: more bytes may complete it. */
  | "truncated"
  /** The input is not a valid zlib stream (bad header, bad block, bad checksum). */
  | "corrupt"
  /** The stream would inflate to more than `maxOutput` bytes. */
  | "output-limit";

export class ZlibError extends Error {
  readonly kind: ZlibErrorKind;
  constructor(kind: ZlibErrorKind, message: string) {
    super(message);
    this.name = "ZlibError";
    this.kind = kind;
  }
}

export interface InflateResult {
  readonly output: Uint8Array;
  /**
   * Input bytes the zlib stream used, through its Adler-32 checksum. Bytes
   * after that (the next pack entry) are not part of it.
   */
  readonly consumed: number;
}

/**
 * zlib (RFC 1950) compression, synchronous, as git stores pack entries and
 * loose objects. `git-core` cannot import a runtime's zlib, so it uses this
 * port: `node:zlib` in Workers (with `nodejs_compat`) and in Node tests.
 */
export interface Zlib {
  /**
   * Inflates one zlib stream from the start of `input`; bytes after the end
   * of the stream are ignored and not counted in `consumed`. Throws
   * `ZlibError`: `output-limit` before producing more than `maxOutput`
   * bytes, `truncated` when `input` ends inside the stream, `corrupt`
   * otherwise. `maxOutput` must be a positive safe integer.
   */
  inflate(input: Uint8Array, options: { readonly maxOutput: number }): InflateResult;
  /** One complete zlib stream holding `input`. `level` is 0 to 9 (default: zlib's default). */
  deflate(input: Uint8Array, options?: { readonly level?: number }): Uint8Array;
}
