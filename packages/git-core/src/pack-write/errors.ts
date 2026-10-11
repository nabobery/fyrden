/** Why a pack could not be written. */
export type PackWriteErrorCode =
  /** More or fewer entries than the object count in the pack header. */
  | "object-count"
  /** A REF_DELTA whose base is not in the pack, or an object that had to be written whole and could not be read. */
  | "missing-base"
  /** Copied entry bytes that fail their CRC32, or a resolved object whose bytes do not hash to its id. */
  | "corrupt-source"
  /** A checkpoint that is truncated, of another version, or for other sources. */
  | "bad-checkpoint"
  /** A checkpoint was asked of a writer whose hasher cannot save its state. */
  | "not-resumable";

export class PackWriteError extends Error {
  readonly code: PackWriteErrorCode;
  /** The message without the code. */
  readonly detail: string;
  constructor(code: PackWriteErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "PackWriteError";
    this.code = code;
    this.detail = detail;
  }
}
