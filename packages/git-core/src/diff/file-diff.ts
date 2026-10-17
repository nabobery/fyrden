import { DEFAULT_CONTEXT_LINES, type Hunk, hunksOf } from "./hunks.js";
import { DEFAULT_MAX_DIFF_COST, diffSequences } from "./line-diff.js";
import { formatHunks, patchText } from "./patch.js";
import { DEFAULT_MAX_LINES, internLines, isBinary, splitLines } from "./text.js";

/** What changed in one file's content. */
export type FileDiff =
  | {
      readonly kind: "text";
      /** The line diff hit its cost bound: it is right, not the shortest. */
      readonly approximate: boolean;
      readonly additions: number;
      readonly deletions: number;
      readonly hunks: readonly Hunk[];
      /** The hunks as patch bytes, each line exactly as stored (what `git apply` takes). */
      readonly patch: Uint8Array;
      /** The patch as text to show (UTF-8, an invalid sequence as U+FFFD). */
      readonly text: string;
    }
  /** Either side is binary: no lines are compared. */
  | { readonly kind: "binary" }
  /** A side has more lines than the budget: not compared. */
  | { readonly kind: "too_large" };

export function diffFile(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  options: {
    readonly context?: number;
    readonly maxCost?: number;
    readonly maxLines?: number;
  } = {},
): FileDiff {
  if (isBinary(oldBytes) || isBinary(newBytes)) return { kind: "binary" };
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const oldLines = splitLines(oldBytes, maxLines);
  const newLines = splitLines(newBytes, maxLines);
  if (!oldLines || !newLines) return { kind: "too_large" };
  const ids = internLines(oldLines, newLines);
  const { edits, approximate } = diffSequences(ids.a, ids.b, {
    maxCost: options.maxCost ?? DEFAULT_MAX_DIFF_COST,
  });
  let additions = 0;
  let deletions = 0;
  for (const e of edits) {
    if (e.kind === "insert") additions += e.length;
    else if (e.kind === "delete") deletions += e.length;
  }
  const hunks = hunksOf(edits, options.context ?? DEFAULT_CONTEXT_LINES);
  const patch = formatHunks(hunks, oldLines, newLines);
  return { kind: "text", approximate, additions, deletions, hunks, patch, text: patchText(patch) };
}
