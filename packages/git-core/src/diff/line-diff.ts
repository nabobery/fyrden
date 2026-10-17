/*
 * Line diff: the shortest edit script between two sequences of lines, by
 * the linear-space variant of Myers' algorithm (E. W. Myers, "An O(ND)
 * Difference Algorithm and Its Variations", Algorithmica 1(2), 1986,
 * section 4b: the middle snake, found by searching from both ends at
 * once, splits the problem in two). Written from the paper; git is only a
 * test oracle. The common prefix and suffix are taken off before every
 * search, so a search always faces at least two differences and each
 * split strictly shrinks both halves.
 *
 * Cost is bounded: past `maxCost` steps of the search, a part that is
 * still undecided is given as deleted and then inserted whole, and the
 * result is flagged `approximate` (it still turns one side into the other,
 * with more changed lines than needed).
 */

export type EditKind = "equal" | "delete" | "insert";

/** A run of lines: equal on both sides, deleted from the old side, or inserted into the new one. */
export interface Edit {
  readonly kind: EditKind;
  /** Where the run starts on each side (a deletion takes no new lines, an insertion no old ones). */
  readonly oldStart: number;
  readonly newStart: number;
  readonly length: number;
}

export interface LineDiff {
  readonly edits: readonly Edit[];
  /** Some part was given whole because finding its shortest script cost too much. */
  readonly approximate: boolean;
}

/** Steps of the search one diff may take. Proposed: a few tens of milliseconds of CPU. */
export const DEFAULT_MAX_DIFF_COST = 4_000_000;

/** Diffs two sequences of line ids (equal ids, equal lines). */
export function diffSequences(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  options: { readonly maxCost?: number } = {},
): LineDiff {
  const out = new EditList();
  const search = new Search(a, b, options.maxCost ?? DEFAULT_MAX_DIFF_COST);
  search.solve(0, a.length, 0, b.length, out);
  return { edits: compact(out.edits, a, b), approximate: search.approximate };
}

/** Appends edits, merging a run into the one before it when they are of the same kind and adjoin. */
class EditList {
  readonly edits: Edit[] = [];

  push(kind: EditKind, oldStart: number, newStart: number, length: number): void {
    if (length === 0) return;
    const last = this.edits.at(-1);
    if (last?.kind === kind) {
      this.edits[this.edits.length - 1] = { ...last, length: last.length + length };
      return;
    }
    this.edits.push({ kind, oldStart, newStart, length });
  }
}

class Search {
  approximate = false;
  #cost = 0;
  /** Furthest x reached on each diagonal, forward and backward; reused across searches. */
  #forward: Int32Array = new Int32Array(0);
  #backward: Int32Array = new Int32Array(0);

  constructor(
    private readonly a: ArrayLike<number>,
    private readonly b: ArrayLike<number>,
    private readonly maxCost: number,
  ) {}

  solve(aLo: number, aHi: number, bLo: number, bHi: number, out: EditList): void {
    const { a, b } = this;
    let prefix = 0;
    while (aLo + prefix < aHi && bLo + prefix < bHi && a[aLo + prefix] === b[bLo + prefix])
      prefix++;
    out.push("equal", aLo, bLo, prefix);
    const lo1 = aLo + prefix;
    const lo2 = bLo + prefix;
    let suffix = 0;
    while (lo1 < aHi - suffix && lo2 < bHi - suffix && a[aHi - suffix - 1] === b[bHi - suffix - 1])
      suffix++;
    const hi1 = aHi - suffix;
    const hi2 = bHi - suffix;
    if (lo1 === hi1 || lo2 === hi2) {
      out.push("delete", lo1, lo2, hi1 - lo1);
      out.push("insert", hi1, lo2, hi2 - lo2);
    } else {
      const snake = this.#middleSnake(lo1, hi1, lo2, hi2);
      if (snake === undefined) {
        this.approximate = true;
        out.push("delete", lo1, lo2, hi1 - lo1);
        out.push("insert", hi1, lo2, hi2 - lo2);
      } else {
        const [x, y, u, v] = snake;
        this.solve(lo1, x, lo2, y, out);
        out.push("equal", x, y, u - x);
        this.solve(u, hi1, v, hi2, out);
      }
    }
    out.push("equal", hi1, hi2, suffix);
  }

  /**
   * The middle snake of a[aLo, aHi) against b[bLo, bHi): absolute
   * coordinates of its start and end, or undefined when the cost bound ran
   * out first.
   */
  #middleSnake(
    aLo: number,
    aHi: number,
    bLo: number,
    bHi: number,
  ): [number, number, number, number] | undefined {
    const { a, b } = this;
    const n = aHi - aLo;
    const m = bHi - bLo;
    const delta = n - m;
    const odd = (delta & 1) !== 0;
    const max = Math.ceil((n + m) / 2);
    // Diagonal k lives at index k + offset in both arrays.
    const offset = max + 1;
    const size = 2 * max + 3;
    if (this.#forward.length < size) {
      this.#forward = new Int32Array(size);
      this.#backward = new Int32Array(size);
    }
    const fwd = this.#forward;
    const bwd = this.#backward;
    fwd[offset + 1] = 0;
    // Backward x counts from the end: distance walked back from (n, m).
    bwd[offset + 1] = 0;
    for (let d = 0; d <= max; d++) {
      this.#cost += 2 * d + 1;
      if (this.#cost > this.maxCost) return undefined;
      // Forward: furthest reaching d-paths on diagonals k = x - y.
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && (fwd[offset + k - 1] as number) < (fwd[offset + k + 1] as number))
            ? (fwd[offset + k + 1] as number)
            : (fwd[offset + k - 1] as number) + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
          x++;
          y++;
        }
        fwd[offset + k] = x;
        // The backward path on the same diagonal is on its diagonal delta - k.
        const back = delta - k;
        if (odd && back >= -(d - 1) && back <= d - 1 && x + (bwd[offset + back] as number) >= n)
          return [aLo + x0, bLo + y0, aLo + x, bLo + y];
      }
      // Backward: the same search on both sequences reversed.
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && (bwd[offset + k - 1] as number) < (bwd[offset + k + 1] as number))
            ? (bwd[offset + k + 1] as number)
            : (bwd[offset + k - 1] as number) + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
          x++;
          y++;
        }
        bwd[offset + k] = x;
        const forward = delta - k;
        if (!odd && forward >= -d && forward <= d && x + (fwd[offset + forward] as number) >= n)
          return [aHi - x, bHi - y, aHi - x0, bHi - y0];
      }
    }
    return undefined;
  }
}

/**
 * Slides each deletion or insertion that has equal lines on both sides as
 * far down as the lines allow (a run of `b` deleted before a `b` is the
 * same change one line later), so equal changes read the same way
 * wherever they are found. Fyrden's own rule: git's choices may differ.
 */
function compact(edits: readonly Edit[], a: ArrayLike<number>, b: ArrayLike<number>): Edit[] {
  const out = edits.map((e) => ({ ...e }));
  for (let i = 1; i + 1 < out.length; i++) {
    const before = out[i - 1] as Edit;
    const run = out[i] as Edit;
    const after = out[i + 1] as Edit;
    if (before.kind !== "equal" || after.kind !== "equal" || run.kind === "equal") continue;
    const side = run.kind === "delete" ? a : b;
    const start = run.kind === "delete" ? run.oldStart : run.newStart;
    let shift = 0;
    while (shift < after.length && side[start + shift] === side[start + run.length + shift])
      shift++;
    if (shift === 0) continue;
    out[i - 1] = { ...before, length: before.length + shift };
    out[i] = {
      ...run,
      oldStart: run.oldStart + shift,
      newStart: run.newStart + shift,
    };
    out[i + 1] = {
      ...after,
      oldStart: after.oldStart + shift,
      newStart: after.newStart + shift,
      length: after.length - shift,
    };
  }
  // A run emptied by a slide leaves two of a kind side by side: one again.
  const merged = new EditList();
  for (const e of out) merged.push(e.kind, e.oldStart, e.newStart, e.length);
  return merged.edits;
}
