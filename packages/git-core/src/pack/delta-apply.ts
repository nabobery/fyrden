import { PackError } from "./errors.js";
import { decodeDeltaSize } from "./varint.js";

/*
 * git's delta format, applied as git v2.53.0 patch-delta.c does:
 * header (base size, result size), then opcodes until the end:
 * - 1xxxxxxx: copy from the base. Bits 0-3 say which offset bytes follow,
 *   bits 4-6 which size bytes; a size of 0 means 0x10000.
 * - 0xxxxxxx (1-127): insert that many literal bytes from the program.
 * - 00000000: reserved, rejected.
 */

/** git's minimum delta program length (delta.h DELTA_SIZE_MIN). */
const DELTA_SIZE_MIN = 4;

export interface DeltaHeader {
  readonly baseSize: number;
  readonly resultSize: number;
  /** Offset of the first opcode. */
  readonly opsStart: number;
}

/** Reads the two sizes at the start of a delta program, rejecting sizes above `maxSize`. */
export function readDeltaHeader(delta: Uint8Array, maxSize: number): DeltaHeader {
  if (delta.length < DELTA_SIZE_MIN) {
    throw new PackError("bad-delta", `delta program shorter than ${DELTA_SIZE_MIN} bytes`);
  }
  const base = decodeDeltaSize(delta, 0, maxSize);
  const result = decodeDeltaSize(delta, base.next, maxSize);
  return { baseSize: base.value, resultSize: result.value, opsStart: result.next };
}

/**
 * Applies `delta` to `base`. Checks, in order: the declared base size equals
 * `base.length`; the result size is at most `maxSize` (before allocating);
 * every copy lies inside the base; the output is exactly the result size.
 */
export function applyDelta(
  base: Uint8Array,
  delta: Uint8Array,
  maxSize: number,
): Uint8Array<ArrayBuffer> {
  const header = readDeltaHeader(delta, maxSize);
  if (header.baseSize !== base.length) {
    throw new PackError(
      "delta-base-size-mismatch",
      `delta expects a ${header.baseSize}-byte base, the base has ${base.length}`,
    );
  }
  const out = new Uint8Array(header.resultSize);
  let pos = header.opsStart;
  let written = 0;
  const top = delta.length;
  while (pos < top) {
    const cmd = delta[pos++] as number;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 7; bit++) {
        if ((cmd & (1 << bit)) === 0) continue;
        if (pos >= top) throw new PackError("bad-delta", "copy arguments run past the end");
        const value = delta[pos++] as number;
        if (bit < 4) offset += value * 2 ** (8 * bit);
        else size += value * 2 ** (8 * (bit - 4));
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) {
        throw new PackError("bad-delta", `copy of ${size} bytes at ${offset} is outside the base`);
      }
      if (size > out.length - written) {
        throw new PackError("delta-result-size-mismatch", "delta writes past its result size");
      }
      out.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (cmd !== 0) {
      if (cmd > top - pos) throw new PackError("bad-delta", "insert runs past the end");
      if (cmd > out.length - written) {
        throw new PackError("delta-result-size-mismatch", "delta writes past its result size");
      }
      out.set(delta.subarray(pos, pos + cmd), written);
      pos += cmd;
      written += cmd;
    } else {
      throw new PackError("bad-delta", "unexpected delta opcode 0");
    }
  }
  if (written !== out.length) {
    throw new PackError(
      "delta-result-size-mismatch",
      `delta produced ${written} bytes, its header says ${out.length}`,
    );
  }
  return out;
}
