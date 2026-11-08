import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignFiles, MAX_ALIGN_WORK } from "../../src/blame/align.js";
import { lines } from "./align-cases.js";

/*
 * Edges the generated vectors rarely reach: a tail cut with no line end in
 * it, a rare line among gone ones, a large offset between the two sides,
 * the exact round limit, and the exact work charged. Each pair's answer was
 * checked against git blame 2.53.0.
 */

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const align = (old: string, new_: string) => alignFiles(bytes(old), bytes(new_));
const reversed = (n: number) => {
  const a = Array.from({ length: n }, (_, k) => `u${k}`);
  return [lines(...a), lines(...[...a].reverse())] as const;
};

describe("alignFiles: edges", () => {
  it("cuts no tail when the common bytes past a block hold no line end", () => {
    const tail = "x".repeat(2000);
    const result = align(`a\n${tail}`, `b\n${tail}`);
    expect(result.kind).toBe("aligned");
    expect([...result.oldOfNew]).toEqual([-1, 1]);
  });

  it("keeps a line rarer than the crowd limit, even among gone lines", () => {
    const old = lines("u1", "u2", "u3", "B", "u5", "u6", "u7", "u8", "C", "u9", "u10", "u11");
    const result = align(old, lines("B", "C", "C", "B", "A", "C", "A", "C"));
    expect([...result.oldOfNew]).toEqual([3, -1, -1, -1, -1, -1, -1, -1]);
  });

  it("gives up a crowded line only with gone lines on both sides", () => {
    const old = lines(...Array.from({ length: 10 }, (_, k) => `u${k}`), "    }", "  }", "}", "");
    const new_ = lines(
      "u0",
      "}",
      "",
      "  }",
      "}",
      "",
      ...Array(6).fill("  }"),
      "",
      "}",
      "  }",
      "  }",
    );
    const result = align(old, new_);
    expect([...result.oldOfNew]).toEqual([
      0, -1, -1, 11, 12, 13, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    ]);
  });

  it("searches a range far off the diagonal it started on", () => {
    const result = align(lines(...Array(200).fill("x"), "p", "q"), lines("q", "p", "x"));
    expect(result.kind).toBe("aligned");
    expect([...result.oldOfNew]).toEqual([201, -1, -1]);
  });

  it("refuses a search one round short of what it needs, and takes it at that round", () => {
    const [a, b] = reversed(40);
    const limits = (maxRounds: number) => ({ maxRounds, maxWork: MAX_ALIGN_WORK });
    expect(alignFiles(bytes(a), bytes(b), limits(40)).kind).toBe("aligned");
    expect(alignFiles(bytes(a), bytes(b), limits(39)).kind).toBe("refused");
  });

  // The work count decides refusal: a charge changed on purpose updates these five values.
  it("charges exactly what it charged when the bound was measured", () => {
    const [a, b] = reversed(100);
    const work = {
      reversed: align(a, b).work,
      crowdedAmongGone: align(
        lines("u1", "u2", "u3", "B", "u5", "u6", "u7", "u8", "C", "u9", "u10", "u11"),
        lines("B", "C", "C", "B", "A", "C", "A", "C"),
      ).work,
      crowdedKept: align(
        lines("a", "S", "S", "g1", "S", "b", "S", "g2", "S", "c"),
        lines("a", "S", "S", "S", "S", "b", "S", "S", "c"),
      ).work,
      crowdedSuffix: align(lines("a", "b", "c", "S"), lines("S", "S", "S", "S", "c", "b", "a", "S"))
        .work,
      crowdedPrefix: align(lines("S", "S", "S", "S", "c", "b", "a", "S"), lines("a", "b", "c", "S"))
        .work,
    };
    expect(work).toEqual({
      reversed: 10303,
      crowdedAmongGone: 33,
      crowdedKept: 25,
      crowdedSuffix: 60,
      crowdedPrefix: 54,
    });
  });
});

interface Refusal {
  readonly id: string;
  readonly old: string;
  readonly new: string;
  readonly oldOfNew: readonly number[];
  readonly unsettled: readonly { start: number; end: number }[];
}

/*
 * Pairs where a refusal rule decides: a wide line, a blank run at its limit, a
 * tie or close call, and how refused ranges reach and join. Each was shrunk
 * from a generated pair, and every line it settles agrees with git blame
 * 2.53.0. What's frozen is exactly what's refused: refusing more loses lines,
 * and refusing less is how a wrong answer gets through.
 */
const REFUSALS: Refusal[] = readFileSync(
  join(import.meta.dirname, "vectors", "refusals.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as Refusal);

describe("alignFiles: what each refusal rule refuses", () => {
  it.each(REFUSALS.map((r) => [r.id, r] as const))("%s", (_, r) => {
    const result = align(r.old, r.new);
    expect(result.kind).toBe("aligned");
    expect([...result.oldOfNew]).toEqual(r.oldOfNew);
    expect(result.kind === "aligned" && result.unsettled).toEqual(r.unsettled);
  });
});
