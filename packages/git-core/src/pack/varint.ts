import { PackError } from "./errors.js";

// A delta program starts with two of these sizes: the base size and the
// result size, each little-endian base 128 (git delta.h, get_delta_hdr_size).
// Ten bytes carry 70 bits, more than git's 64-bit size_t can hold.
const MAX_DELTA_SIZE_BYTES = 10;

/**
 * Decodes one delta header size at `pos`. Rejects a value above `max` as
 * soon as it exceeds it, so a hostile size never reaches an allocation, and a
 * varint that runs off the end of the program.
 */
export function decodeDeltaSize(
  bytes: Uint8Array,
  pos: number,
  max: number,
): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < MAX_DELTA_SIZE_BYTES; i++) {
    if (pos >= bytes.length)
      throw new PackError("bad-delta", "delta header size runs past the end");
    const byte = bytes[pos++] as number;
    value += (byte & 0x7f) * scale;
    if (value > max) {
      throw new PackError("object-too-large", `delta header size above the ${max}-byte cap`);
    }
    if ((byte & 0x80) === 0) return { value, next: pos };
    scale *= 128;
  }
  throw new PackError("bad-delta", "delta header size is too long");
}

export function encodeDeltaSize(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`bad delta size ${value}`);
  const out: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return new Uint8Array(out);
}
