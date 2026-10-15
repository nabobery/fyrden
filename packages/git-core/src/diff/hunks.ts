import type { Edit } from "./line-diff.js";

/** The lines of context around each change in a hunk (git's default). */
export const DEFAULT_CONTEXT_LINES = 3;

export interface HunkLine {
  /** ` ` context, `-` from the old side, `+` from the new. */
  readonly kind: " " | "-" | "+";
  /** The line's index on its side (the old side's for context). */
  readonly index: number;
}

export interface Hunk {
  /** 1-based first line on each side, as a unified diff numbers them; 0 for an empty range. */
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly HunkLine[];
}

/**
 * The hunks of a diff: each change with `context` equal lines around it,
 * changes closer than twice that sharing one hunk.
 */
export function hunksOf(edits: readonly Edit[], context = DEFAULT_CONTEXT_LINES): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < edits.length) {
    if (edits[i]?.kind === "equal") {
      i++;
      continue;
    }
    // A hunk runs from this change to the last one whose gap stays within 2 * context.
    let last = i;
    for (let j = i + 1; j < edits.length; j++) {
      const e = edits[j] as Edit;
      if (e.kind !== "equal") last = j;
      else if (e.length > 2 * context || j === edits.length - 1) break;
    }
    const first = edits[i] as Edit;
    const before = i > 0 && edits[i - 1]?.kind === "equal" ? (edits[i - 1] as Edit) : undefined;
    const after =
      last + 1 < edits.length && edits[last + 1]?.kind === "equal"
        ? (edits[last + 1] as Edit)
        : undefined;
    const lead = Math.min(context, before?.length ?? 0);
    const trail = Math.min(context, after?.length ?? 0);
    const lines: HunkLine[] = [];
    for (let k = 0; k < lead; k++) lines.push({ kind: " ", index: first.oldStart - lead + k });
    for (let j = i; j <= last; j++) {
      const e = edits[j] as Edit;
      for (let k = 0; k < e.length; k++)
        lines.push(
          e.kind === "equal"
            ? { kind: " ", index: e.oldStart + k }
            : e.kind === "delete"
              ? { kind: "-", index: e.oldStart + k }
              : { kind: "+", index: e.newStart + k },
        );
    }
    if (after) for (let k = 0; k < trail; k++) lines.push({ kind: " ", index: after.oldStart + k });
    const oldLines = lines.filter((l) => l.kind !== "+").length;
    const newLines = lines.filter((l) => l.kind !== "-").length;
    const oldFrom = first.oldStart - lead;
    const newFrom = first.newStart - lead;
    hunks.push({
      // An empty range names the line before it, as unified diffs do.
      oldStart: oldLines === 0 ? oldFrom : oldFrom + 1,
      oldLines,
      newStart: newLines === 0 ? newFrom : newFrom + 1,
      newLines,
      lines,
    });
    i = last + 1;
  }
  return hunks;
}
