import { diffSequences, type Edit } from "../diff/line-diff.js";

/*
 * Three-way merge of line sequences: diff3 as S. Khanna, K. Kunal and B.
 * C. Pierce formalise it ("A Formal Investigation of Diff3", FSTTCS 2007).
 * Each side is aligned with the base by a shortest edit script (our line
 * diff); lines of the base both sides keep unchanged are the stable points
 * that split the three into chunks. Between two stable points, a chunk
 * that only one side changed takes that side; one both changed the same
 * way takes either; one they changed differently is a conflict. Written
 * from the paper; git is only a test oracle.
 */

export type MergeChunk =
  /** Lines that merge cleanly. */
  | { readonly kind: "clean"; readonly lines: readonly number[] }
  /** Lines the two sides changed differently, with the base they started from. */
  | {
      readonly kind: "conflict";
      readonly base: readonly number[];
      readonly ours: readonly number[];
      readonly theirs: readonly number[];
    };

export interface MergeResult {
  readonly chunks: readonly MergeChunk[];
  readonly conflicts: number;
  /** A line diff hit its cost bound: chunks may be wider than they need be. */
  readonly approximate: boolean;
}

/** For each base line, the line of `side` it matches, or -1 when that side changed it. */
function matches(edits: readonly Edit[], baseLength: number): Int32Array {
  const match = new Int32Array(baseLength).fill(-1);
  for (const e of edits)
    if (e.kind === "equal")
      for (let i = 0; i < e.length; i++) match[e.oldStart + i] = e.newStart + i;
  return match;
}

/** Merges `ours` and `theirs`, both changed from `base` (sequences of line ids). */
export function merge3(
  base: ArrayLike<number>,
  ours: ArrayLike<number>,
  theirs: ArrayLike<number>,
  options: { readonly maxCost?: number } = {},
): MergeResult {
  const toOurs = diffSequences(base, ours, options);
  const toTheirs = diffSequences(base, theirs, options);
  const a = matches(toOurs.edits, base.length);
  const b = matches(toTheirs.edits, base.length);
  const chunks: MergeChunk[] = [];
  let conflicts = 0;
  const slice = (seq: ArrayLike<number>, from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => seq[from + i] as number);
  // The clean chunk being built: appended to in place, never copied.
  let open: number[] | undefined;
  const pushClean = (lines: readonly number[]) => {
    if (lines.length === 0) return;
    if (!open) {
      open = [];
      chunks.push({ kind: "clean", lines: open });
    }
    for (const line of lines) open.push(line);
  };
  /** Equal sequences? */
  const same = (x: readonly number[], y: readonly number[]) =>
    x.length === y.length && x.every((v, i) => v === y[i]);

  // Positions reached on each sequence: base, ours, theirs.
  let o = 0;
  let p = 0;
  let q = 0;
  while (o <= base.length) {
    // The next stable base line: kept by both sides, at or after the ones already passed.
    let next = o;
    while (next < base.length && !((a[next] as number) >= p && (b[next] as number) >= q)) next++;
    const oursEnd = next < base.length ? (a[next] as number) : ours.length;
    const theirsEnd = next < base.length ? (b[next] as number) : theirs.length;
    // The unstable chunk between the stable points.
    const baseChunk = slice(base, o, next);
    const oursChunk = slice(ours, p, oursEnd);
    const theirsChunk = slice(theirs, q, theirsEnd);
    if (same(oursChunk, baseChunk)) pushClean(theirsChunk);
    else if (same(theirsChunk, baseChunk) || same(oursChunk, theirsChunk)) pushClean(oursChunk);
    else {
      conflicts++;
      open = undefined;
      chunks.push({ kind: "conflict", base: baseChunk, ours: oursChunk, theirs: theirsChunk });
    }
    if (next >= base.length) break;
    // The stable run: every following base line both sides keep in step.
    let run = 0;
    while (
      next + run < base.length &&
      a[next + run] === oursEnd + run &&
      b[next + run] === theirsEnd + run
    )
      run++;
    pushClean(slice(base, next, next + run));
    o = next + run;
    p = oursEnd + run;
    q = theirsEnd + run;
  }
  return { chunks, conflicts, approximate: toOurs.approximate || toTheirs.approximate };
}
