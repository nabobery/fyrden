import { type Zlib, ZlibError } from "../ports/zlib.js";
import { PackError } from "./errors.js";

/**
 * The longest zlib stream accepted for an entry of `size` bytes. zlib itself
 * never needs more than about size + size/1000 (deflateBound); other
 * encoders can be less tight (Go's compress/flate may keep a Huffman block
 * up to 1/16 larger than a stored one, unverified). Proposed: 1/8 plus 1 KiB.
 * The bound keeps a hostile entry from making the parser buffer an endless
 * stream of empty blocks.
 */
export function maxCompressedBytes(size: number): number {
  return size + Math.ceil(size / 8) + 1024;
}

/** Thrown by `inflateEntry` when the input ends inside the zlib stream. */
export class NeedMoreInput extends Error {
  constructor() {
    super("zlib stream continues past the bytes given");
    this.name = "NeedMoreInput";
  }
}

/**
 * Inflates one entry's zlib stream from the start of `input`, which must
 * produce exactly `size` bytes. Inflate is bounded at `size + 1` bytes, so a
 * bomb is stopped after one byte too many. Throws `NeedMoreInput` when
 * `input` ends inside the stream, and `PackError` for everything else.
 */
export function inflateEntry(
  zlib: Zlib,
  input: Uint8Array,
  size: number,
  entryOffset: number,
): { data: Uint8Array; consumed: number } {
  let result: { output: Uint8Array; consumed: number };
  try {
    result = zlib.inflate(input, { maxOutput: size + 1 });
  } catch (error) {
    if (!(error instanceof ZlibError)) throw error;
    if (error.kind === "truncated") throw new NeedMoreInput();
    if (error.kind === "output-limit") {
      throw new PackError("inflate-bomb", `inflates to more than its ${size} bytes`, entryOffset);
    }
    throw new PackError("bad-zlib", error.message, entryOffset);
  }
  if (result.output.length > size) {
    throw new PackError("inflate-bomb", `inflates to more than its ${size} bytes`, entryOffset);
  }
  if (result.output.length < size) {
    throw new PackError(
      "size-mismatch",
      `inflates to ${result.output.length} bytes, its header says ${size}`,
      entryOffset,
    );
  }
  return { data: result.output, consumed: result.consumed };
}
