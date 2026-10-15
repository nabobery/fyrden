import {
  DEFAULT_MAX_LINES,
  isBinary,
  type Lines,
  latin1,
  lineAt,
  splitLines,
} from "../diff/text.js";
import { merge3 } from "./diff3.js";

/** A conflict between the two sides, as the lines of each (bytes, each with its line feed if it had one). */
export interface ConflictRegion {
  readonly base: readonly Uint8Array[];
  readonly ours: readonly Uint8Array[];
  readonly theirs: readonly Uint8Array[];
}

export type FileMerge =
  | { readonly kind: "clean"; readonly bytes: Uint8Array; readonly approximate: boolean }
  /** The sides changed the same lines differently: the merged lines, conflicts as data. */
  | {
      readonly kind: "conflict";
      readonly regions: readonly ({ readonly clean: readonly Uint8Array[] } | ConflictRegion)[];
      readonly conflicts: number;
    }
  /** A side is binary: no lines to merge. */
  | { readonly kind: "binary" }
  /** A side has more lines than the budget. */
  | { readonly kind: "too_large" };

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Merges two files changed from a common base, line by line (diff3). */
export function mergeFiles(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
  options: { readonly maxLines?: number; readonly maxCost?: number } = {},
): FileMerge {
  if (isBinary(base) || isBinary(ours) || isBinary(theirs)) return { kind: "binary" };
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const sides = [base, ours, theirs].map((bytes) => splitLines(bytes, maxLines));
  if (sides.some((s) => s === undefined)) return { kind: "too_large" };
  const [b, o, t] = sides as [Lines, Lines, Lines];
  // One id space for the three: lines equal anywhere get one id.
  const ids = new Map<string, number>();
  const lines: Uint8Array[] = [];
  const idOf = (bytes: Uint8Array) => {
    const key = latin1(bytes);
    let id = ids.get(key);
    if (id === undefined) {
      id = lines.length;
      ids.set(key, id);
      lines.push(bytes);
    }
    return id;
  };
  const toIds = (side: Lines) =>
    Uint32Array.from({ length: side.count }, (_, i) => idOf(lineAt(side, i)));
  const merged = merge3(toIds(b), toIds(o), toIds(t), options);
  const bytesOf = (seq: readonly number[]) => seq.map((id) => lines[id] as Uint8Array);
  if (merged.conflicts === 0)
    return {
      kind: "clean",
      bytes: concat(merged.chunks.flatMap((c) => (c.kind === "clean" ? bytesOf(c.lines) : []))),
      approximate: merged.approximate,
    };
  return {
    kind: "conflict",
    conflicts: merged.conflicts,
    regions: merged.chunks.map((c) =>
      c.kind === "clean"
        ? { clean: bytesOf(c.lines) }
        : { base: bytesOf(c.base), ours: bytesOf(c.ours), theirs: bytesOf(c.theirs) },
    ),
  };
}
