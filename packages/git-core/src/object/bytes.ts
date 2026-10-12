/** Small byte helpers for object encoding. Object text is bytes, not UTF-8. */

/**
 * A copy of `bytes[start, end)` in a new buffer. Not `slice()`: a Node
 * `Buffer` is a `Uint8Array` whose `slice()` returns a view, which would keep
 * the caller's buffer alive and change when it does.
 */
export function copyBytes(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes.subarray(start, end));
}

/** One byte per character; the inverse of `latin1`. Characters must be U+0000 to U+00FF. */
export function latin1Bytes(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new RangeError("text has a character above U+00FF");
    out[i] = code;
  }
  return out;
}

/** One character per byte, so any byte string maps to a distinct string. */
export function latin1(bytes: Uint8Array): string {
  let text = "";
  // In slices, so a long run of bytes cannot overflow the argument limit.
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

export function concatBytes(parts: readonly Uint8Array[], total?: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total ?? parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function startsWithAscii(bytes: Uint8Array, offset: number, prefix: string): boolean {
  if (offset + prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[offset + i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}
