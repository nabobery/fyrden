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

const LF = 0x0a;
const CR = 0x0d;

/** How a line ends: CRLF, LF, or unknown (no line, or no line feed). */
function endingOf(line: Uint8Array | undefined): "crlf" | "lf" | undefined {
  if (!line || line[line.length - 1] !== LF) return undefined;
  return line.length >= 2 && line[line.length - 2] === CR ? "crlf" : "lf";
}

/** The first line of `bytes`, with its line feed. */
function firstLine(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length === 0) return undefined;
  const lf = bytes.indexOf(LF);
  return lf < 0 ? bytes : bytes.subarray(0, lf + 1);
}

/**
 * A conflicted merge as one file with conflict markers, as git writes one
 * (`merge` style): each conflict is `<<<<<<< ours`, our lines, `=======`,
 * their lines, `>>>>>>> theirs`; a side whose last line has no line feed
 * gets one before the next marker. Marker lines end with CRLF, as git's
 * do (observed against `git merge-file`), only when the base's first line
 * does and neither side's line before the conflict (its first line, at the
 * start) ends with a bare LF; else with LF.
 */
export function withConflictMarkers(
  regions: Extract<FileMerge, { kind: "conflict" }>["regions"],
  labels: { readonly ours: string; readonly theirs: string },
  files: { readonly base: Uint8Array; readonly ours: Uint8Array; readonly theirs: Uint8Array },
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const baseCrlf = endingOf(firstLine(files.base)) === "crlf";
  // The last line of each side so far (a clean line is both sides').
  let ours: Uint8Array | undefined;
  let theirs: Uint8Array | undefined;
  for (const region of regions) {
    if ("clean" in region) {
      parts.push(...region.clean);
      const last = region.clean.at(-1);
      if (last) [ours, theirs] = [last, last];
      continue;
    }
    const crlf =
      baseCrlf &&
      endingOf(ours ?? firstLine(files.ours)) !== "lf" &&
      endingOf(theirs ?? firstLine(files.theirs)) !== "lf";
    const eol = crlf ? "\r\n" : "\n";
    const side = (lines: readonly Uint8Array[]) => {
      parts.push(...lines);
      const last = lines.at(-1);
      if (last && last[last.length - 1] !== LF) parts.push(encoder.encode(eol));
    };
    parts.push(encoder.encode(`<<<<<<< ${labels.ours}${eol}`));
    side(region.ours);
    parts.push(encoder.encode(`=======${eol}`));
    side(region.theirs);
    parts.push(encoder.encode(`>>>>>>> ${labels.theirs}${eol}`));
    ours = region.ours.at(-1) ?? ours;
    theirs = region.theirs.at(-1) ?? theirs;
  }
  return concat(parts);
}
