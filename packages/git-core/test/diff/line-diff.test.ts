import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffSequences, type Edit } from "../../src/diff/line-diff.js";

/** The new side, rebuilt from the old one and the edits. */
function apply(a: readonly number[], b: readonly number[], edits: readonly Edit[]): number[] {
  const out: number[] = [];
  let oldAt = 0;
  let newAt = 0;
  for (const e of edits) {
    expect(e.oldStart).toBe(oldAt);
    expect(e.newStart).toBe(newAt);
    if (e.kind === "equal") {
      for (let i = 0; i < e.length; i++) expect(a[oldAt + i]).toBe(b[newAt + i]);
      out.push(...a.slice(oldAt, oldAt + e.length));
      oldAt += e.length;
      newAt += e.length;
    } else if (e.kind === "delete") {
      oldAt += e.length;
    } else {
      out.push(...b.slice(newAt, newAt + e.length));
      newAt += e.length;
    }
  }
  expect(oldAt).toBe(a.length);
  return out;
}

const changed = (edits: readonly Edit[]) =>
  edits.filter((e) => e.kind !== "equal").reduce((n, e) => n + e.length, 0);

/** The fewest lines any edit script changes: n + m - 2 * LCS. */
function fewest(a: readonly number[], b: readonly number[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j] as number;
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(up, row[j - 1] as number);
      diag = up;
    }
  }
  return a.length + b.length - 2 * (row[b.length] as number);
}

const lines = fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 40 });

describe("diffSequences", () => {
  it("turns the old side into the new one with the fewest changed lines", () => {
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        const { edits, approximate } = diffSequences(a, b);
        expect(approximate).toBe(false);
        expect(apply(a, b, edits)).toEqual(b);
        expect(changed(edits)).toBe(fewest(a, b));
        // Runs alternate in kind: no two of a kind side by side.
        for (let i = 1; i < edits.length; i++) expect(edits[i]?.kind).not.toBe(edits[i - 1]?.kind);
      }),
      { numRuns: 2_000 },
    );
  });

  it("gives a costly part whole, flagged approximate, still turning one side into the other", () => {
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        const { edits } = diffSequences(a, b, { maxCost: 1 });
        expect(apply(a, b, edits)).toEqual(b);
      }),
    );
    const a = Array.from({ length: 200 }, (_, i) => i % 7);
    const b = Array.from({ length: 200 }, (_, i) => (i * 3) % 7);
    expect(diffSequences(a, b, { maxCost: 10 }).approximate).toBe(true);
  });

  it("slides a deletion between repeated lines to its last place", () => {
    // Deleting one of two equal lines reads as deleting the second.
    const { edits } = diffSequences([1, 2, 2, 3], [1, 2, 3]);
    expect(edits).toEqual([
      { kind: "equal", oldStart: 0, newStart: 0, length: 2 },
      { kind: "delete", oldStart: 2, newStart: 2, length: 1 },
      { kind: "equal", oldStart: 3, newStart: 2, length: 1 },
    ]);
  });

  it("handles empty sides", () => {
    expect(diffSequences([], []).edits).toEqual([]);
    expect(diffSequences([], [1, 2]).edits).toEqual([
      { kind: "insert", oldStart: 0, newStart: 0, length: 2 },
    ]);
    expect(diffSequences([1], []).edits).toEqual([
      { kind: "delete", oldStart: 0, newStart: 0, length: 1 },
    ]);
  });
});
