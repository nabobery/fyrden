/** Bytes looked at to decide whether content is binary: a NUL among them makes it so (as git decides, unverified). */
export const BINARY_SNIFF_BYTES = 8_000;

/** Lines one side of a file diff may have; past it the file is too large to compare. Proposed. */
export const DEFAULT_MAX_LINES = 100_000;

/** Whether a file is binary: a NUL in its first {@link BINARY_SNIFF_BYTES} bytes. */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * A file's lines as offsets into its bytes: line `i` is
 * `bytes[starts[i], starts[i + 1])`, with its line feed (the last one has
 * none when the file does not end with one). Compact: four bytes a line,
 * whatever the lines are like.
 */
export interface Lines {
  readonly bytes: Uint8Array;
  /** `count + 1` offsets: each line's start, then the end of the last. */
  readonly starts: Uint32Array;
  readonly count: number;
}

/** A file's lines; undefined when it has more than `maxLines`. */
export function splitLines(bytes: Uint8Array, maxLines = DEFAULT_MAX_LINES): Lines | undefined {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) count++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) count++;
  if (count > maxLines) return undefined;
  const starts = new Uint32Array(count + 1);
  let line = 1;
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 0x0a && line < count) starts[line++] = i + 1;
  starts[count] = bytes.length;
  return { bytes, starts, count };
}

/** Line `i`'s bytes. */
export function lineAt(lines: Lines, i: number): Uint8Array {
  return lines.bytes.subarray(lines.starts[i], lines.starts[i + 1]);
}

/**
 * Both sides' lines as ids, equal lines with equal ids, compared byte for
 * byte (a line without its line feed differs from the same line with one).
 * Keys are exact (one character per byte), so crafted lines cannot collide;
 * the line budget bounds their number.
 */
export function internLines(a: Lines, b: Lines): { a: Uint32Array; b: Uint32Array } {
  const ids = new Map<string, number>();
  const idsOf = (lines: Lines) => {
    const out = new Uint32Array(lines.count);
    for (let i = 0; i < lines.count; i++) {
      const key = latin1(lineAt(lines, i));
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  };
  return { a: idsOf(a), b: idsOf(b) };
}

/** One character per byte, built in bounded chunks: a key that tells different bytes apart, whatever their encoding. */
export function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}
