import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  alignFiles,
  MAX_ALIGN_WORK,
  MAX_SEARCH_ROUNDS,
  scanAlignment,
} from "../../src/blame/align.js";
import { lines } from "./align-cases.js";

/*
 * What the oracle can't settle: a search past its round limit, and slides
 * too close to call. Lines are left unresolved rather than guessed, and what
 * no alignment could change stays settled.
 */

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const numbered = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, k) => `${prefix}${k}`);

function aligned(old: string, new_: string) {
  const result = alignFiles(bytes(old), bytes(new_));
  if (result.kind !== "aligned") throw new Error("expected an alignment");
  return result;
}

/** A search that needs more than the round limit: every line is common, in opposite order. */
const reversed = (n: number) => [numbered("u", n), numbered("u", n).reverse()] as const;

describe("alignFiles: what's charged", () => {
  it("charges looking at crowded lines before doing it", () => {
    // 100,000 short lines, all crowded, and no search to speak of.
    const parent = "x\n".repeat(99_998);
    const result = alignFiles(bytes(`a\n${parent}b\n`), bytes(parent), {
      maxRounds: MAX_SEARCH_ROUNDS,
      maxWork: 1,
    });
    expect(result.kind).toBe("refused");
  });

  it("does the same on a side where every line has to be walked from", () => {
    const old = Array.from({ length: 10_000 }, (_, k) => (k % 2 === 0 ? "x" : `u${k}`));
    const whole = alignFiles(
      bytes(lines(...old)),
      bytes(lines(...numbered("x", 1), ..."x".repeat(200))),
    );
    expect(whole.kind).toBe("aligned");
    expect(whole.work).toBeGreaterThanOrEqual(old.length);
  });
});

describe("alignFiles: a tie between different shapes", () => {
  // A later position wins a tie only where the positions look alike. These two tie on
  // the figures, and look different: the oracle takes the earlier.
  it.each([
    [
      ["    }", "  }", "u", "  }", "    return;"],
      ["    }", "  }", "    return;"],
    ],
    [
      ["u0", "  }", "    }", "  }", "{", "  }"],
      ["u0", "  }", "{"],
    ],
    [
      ["u0", "  }", "    }", "  }", "u1", "  }"],
      ["u0", "  }", "u1"],
    ],
    [
      ["    }", "  }", "u", "  }", "    }"],
      ["    }", "  }", "    }"],
    ],
  ])("%j to %j: says so, rather than guessing", (old, new_) => {
    const result = aligned(lines(...old), lines(...new_));
    expect(result.unsettled.length).toBeGreaterThan(0);
  });

  it("a tie between positions that look alike stays settled", () => {
    const result = aligned(lines("t", "a", "a", "a", "b"), lines("t", "a", "b"));
    expect(result.unsettled).toEqual([]);
  });
});

describe("alignFiles: what scoring can't read", () => {
  // A line of only spaces and tabs, as wide as an indentation the scan can't score.
  const wideCase = (blank: string) => aligned(`  }\n${blank}\n`, `  }\n  }\n${blank}\n`);
  it.each([
    ["199 spaces", " ".repeat(199)],
    ["24 tabs", "\t".repeat(24)],
    ["199 spaces and a carriage return", `${" ".repeat(199)}\r`],
  ])("a blank line of %s is read", (_title, blank) => {
    expect(wideCase(blank).unsettled).toEqual([]);
  });
  it.each([
    ["200 spaces", " ".repeat(200)],
    ["300 spaces", " ".repeat(300)],
    ["25 tabs", "\t".repeat(25)],
    ["193 spaces and a tab", `${" ".repeat(193)}\t`],
  ])("a blank line of %s isn't, and says so", (_title, blank) => {
    expect(wideCase(blank).unsettled.length).toBeGreaterThan(0);
  });

  it("a line too wide to score is refused before all of it is read", () => {
    // A mebibyte of spaces before one letter: past 200 columns nothing more is learned.
    const wide = `${" ".repeat(1024 * 1024 - 16)}y`;
    const result = aligned(lines("a", wide, "a", "b"), lines("a", "b"));
    expect(result.unsettled.length).toBeGreaterThan(0);
    expect(result.work).toBeLessThan(10_000);
  });
  it("so is a blank line of 300 carriage returns, which scoring doesn't read either", () => {
    expect(wideCase("\r".repeat(300)).unsettled.length).toBeGreaterThan(0);
  });

  // `top`, n blank lines, then a group that slides past them: the run's limit is 20.
  const runCase = (n: number) => {
    const blanks = Array.from({ length: n }, () => "");
    return aligned(
      lines("top", ...blanks, "  x", "    ", "  x", "  y"),
      lines("top", ...blanks, "  x", "  y"),
    );
  };
  it("19 blank lines are read", () => {
    expect(runCase(19).unsettled).toEqual([]);
  });
  it("20 blank lines reach the run's limit, which isn't trusted", () => {
    expect(runCase(20).unsettled).toEqual([{ start: 21, end: 22 }]);
  });
});

describe("alignFiles: a whole refusal", () => {
  it("refuses a search reaching 256 rounds, and accepts one just under", () => {
    const [a, b] = reversed(2 * MAX_SEARCH_ROUNDS);
    const result = alignFiles(bytes(lines(...a)), bytes(lines(...b)));
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toBe("diff_budget");
    // A hundred lines moved is far under the limit.
    const [c, d] = reversed(100);
    expect(alignFiles(bytes(lines(...c)), bytes(lines(...d))).kind).toBe("aligned");
  });

  it("gives up at the round limit it was given", () => {
    const [a, b] = reversed(40);
    const old = bytes(lines(...a));
    const new_ = bytes(lines(...b));
    expect(alignFiles(old, new_, { maxRounds: 4, maxWork: MAX_ALIGN_WORK }).kind).toBe("refused");
    expect(alignFiles(old, new_, { maxRounds: 200, maxWork: MAX_ALIGN_WORK }).kind).toBe("aligned");
  });

  it("refuses past its work limit, and reports the work done within it", () => {
    const [a, b] = reversed(100);
    const old = bytes(lines(...a));
    const new_ = bytes(lines(...b));
    const whole = alignFiles(old, new_);
    expect(whole.work).toBeGreaterThan(100);
    expect(alignFiles(old, new_, { maxRounds: 256, maxWork: whole.work }).kind).toBe("aligned");
    expect(alignFiles(old, new_, { maxRounds: 256, maxWork: whole.work - 1 }).kind).toBe("refused");
  });

  it("keeps common ends only where a line that occurs once in each file seals them", () => {
    const [a, b] = reversed(2 * MAX_SEARCH_ROUNDS);
    // `dup` also occurs in the middle, so what's nearer the middle than `once` isn't sealed.
    const old = lines("once", "dup", ...a, "tail1", "dup2", "dup");
    const new_ = lines("once", "dup", ...b, "tail1", "dup2", "dup");
    const result = alignFiles(bytes(old), bytes(new_));
    expect(result.kind).toBe("refused");
    const { oldOfNew } = result;
    const count = oldOfNew.length;
    expect(oldOfNew[0]).toBe(0);
    expect(oldOfNew[1]).toBe(-1);
    expect(oldOfNew[2]).toBe(-1);
    // `tail1` is nearest the middle and occurs once, so everything past it is sealed too.
    expect(oldOfNew[count - 3]).toBe(count - 3);
    expect(oldOfNew[count - 2]).toBe(count - 2);
    expect(oldOfNew[count - 1]).toBe(count - 1);
  });

  it("doesn't seal what's nearer the middle than the sealing line", () => {
    const [a, b] = reversed(2 * MAX_SEARCH_ROUNDS);
    const result = alignFiles(
      bytes(lines(...a, "dup", "tail1", "dup")),
      bytes(lines(...b, "dup", "tail1", "dup")),
    );
    expect(result.kind).toBe("refused");
    const { oldOfNew } = result;
    const count = oldOfNew.length;
    expect(oldOfNew[count - 3]).toBe(-1);
    expect(oldOfNew[count - 2]).toBe(count - 2);
    expect(oldOfNew[count - 1]).toBe(count - 1);
  });

  it("keeps the tail cut's lines, which pair however long the files differ", () => {
    const [a, b] = reversed(2 * MAX_SEARCH_ROUNDS);
    const tail = numbered("t", 400);
    const extra = ["only-new"];
    const result = alignFiles(bytes(lines(...a, ...tail)), bytes(lines(...b, ...extra, ...tail)));
    expect(result.kind).toBe("refused");
    const paired = [...result.oldOfNew].filter((old) => old >= 0);
    expect(paired.length).toBeGreaterThan(0);
    const newCount = a.length + 1 + tail.length;
    expect(result.oldOfNew[newCount - 1]).toBe(a.length + tail.length - 1);
    expect(result.oldOfNew[a.length]).toBe(-1);
  });

  it("scanAlignment has no pick at the round limit", () => {
    const [a, b] = reversed(2 * MAX_SEARCH_ROUNDS);
    expect(() => scanAlignment(bytes(lines(...a)), bytes(lines(...b)))).toThrow();
  });
});

describe("alignFiles: a close call", () => {
  it("leaves the group's range unsettled, whatever the scan would pick", () => {
    // Three positions, within a few of each other under the fitted score.
    const old = lines("top", "8x", "3y", "bot", "bot");
    const new_ = lines("top", "8x", "3y", "8x", "3y", "bot", "bot");
    const result = aligned(old, new_);
    expect(result.unsettled).toEqual([{ start: 1, end: 5 }]);
    // The raw pick still answers, and pairs outside the range stand.
    expect(result.oldOfNew[0]).toBe(0);
    expect(result.oldOfNew[5]).toBe(3);
    expect(result.oldOfNew[6]).toBe(4);
  });

  it("refuses the reviewer's witness", () => {
    const result = aligned(lines("top", "", "", "1c"), lines("top", "", "", "1c", "", "", "1c"));
    expect(result.unsettled.length).toBeGreaterThan(0);
  });

  // The margin's two sides, each checked against git blame 2.53.0. Git takes the raw pick in
  // both, so these hold the margin where it was measured, not a wrong answer.
  it("refuses a difference of 16, the widest miss found", () => {
    const result = aligned("  x\n x\ntail\n", "  x\n x\n  x\n\t\t\n x\ntail\n");
    expect(result.unsettled).toEqual([{ start: 1, end: 5 }]);
    expect([...result.oldOfNew]).toEqual([0, -1, -1, -1, 1, 2]);
  });

  it("settles a difference of 17", () => {
    const result = aligned("top\n\n  x\n", "top\n\n\n  x\n");
    expect(result.unsettled).toEqual([]);
    expect([...result.oldOfNew]).toEqual([0, 1, -1, 2]);
  });

  it("settles a clear choice, and exact ties between equal candidates", () => {
    expect(aligned(lines("a", "b"), lines("a", "b", "c")).unsettled).toEqual([]);
    // Every position's terms are equal: the lowest, with no refusal.
    const tie = aligned(lines("a"), lines("a", "a"));
    expect(tie.unsettled).toEqual([]);
    expect([...tie.oldOfNew]).toEqual([0, -1]);
  });

  it("reaches new lines that pair into a refused old group's range", () => {
    // The same doubling, deleted: the group sits on the old side.
    const old = lines("top", "8x", "3y", "8x", "3y", "bot", "bot");
    const new_ = lines("top", "8x", "3y", "bot", "bot");
    const result = aligned(old, new_);
    expect(result.unsettled).toEqual([{ start: 1, end: 3 }]);
    expect(result.oldOfNew[0]).toBe(0);
    expect(result.oldOfNew[3]).toBe(5);
  });

  it("carries an old-side refusal to a new group whose positions overlap its counts", () => {
    // Found by search. New line 3 is a group of its own, changed, and can't be a close call by itself.
    const old = lines("p", "", "p", "top", "p", "p", "", "   y", "");
    const new_ = lines("p", "top", "top");
    const result = aligned(old, new_);
    expect([...result.oldOfNew]).toEqual([2, 3, -1]);
    expect(result.unsettled).toEqual([{ start: 0, end: 3 }]);
  });

  it("refuses when scoring would need a line indented past 200 columns", () => {
    const deep = `${" ".repeat(201)}x`;
    const old = lines("top", deep, "y", "bot", "bot");
    const new_ = lines("top", deep, "y", deep, "y", "bot", "bot");
    expect(aligned(old, new_).unsettled.length).toBeGreaterThan(0);
    const fine = " ".repeat(200);
    const clear = aligned(
      lines("top", `${fine}x`, `${fine}y`, "bot"),
      lines("top", `${fine}x`, `${fine}y`, `${fine}x`, `${fine}y`, "bot"),
    );
    expect(clear.oldOfNew.length).toBe(6);
  });

  it("refuses a split that reads a blank line of 200 columns or more, however wide", () => {
    const blank = " ".repeat(5000);
    const result = aligned(
      lines("top", blank, "a", "z"),
      lines("top", blank, "a", blank, "a", "z"),
    );
    expect(result.unsettled).toEqual([{ start: 1, end: 4 }]);
    expect([...result.oldOfNew]).toEqual([0, 1, -1, -1, 2, 3]);
    const refusedOver = aligned(lines("top", "a", "z"), lines("top", "a", "a", "z"));
    expect(refusedOver.oldOfNew.length).toBe(4);
  });
});

describe("alignFiles: what every answer holds to", () => {
  const line = fc.constantFrom(
    "a\n",
    "b\n",
    "c\n",
    "\n",
    "  a\n",
    "    b\n",
    "\t\n",
    "x",
    "\r\n",
    "a\r\n",
  );
  const file = fc.array(line, { maxLength: 40 }).map((parts) => {
    // Only the last line may lack a line feed.
    return parts
      .map((part, k) => (k < parts.length - 1 && !part.endsWith("\n") ? `${part}\n` : part))
      .join("");
  });
  const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  it("pairs only equal lines, in order, and marks ranges within the file", () => {
    fc.assert(
      fc.property(file, file, (old, new_) => {
        const result = alignFiles(bytes(old), bytes(new_));
        const a = linesOf(old);
        const b = linesOf(new_);
        expect(result.oldOfNew.length).toBe(b.length);
        let last = -1;
        result.oldOfNew.forEach((at, k) => {
          if (at < 0) return;
          expect(at).toBeGreaterThan(last);
          last = at;
          expect(a[at]).toBe(b[k]);
        });
        if (result.kind === "aligned") {
          for (const { start, end } of result.unsettled) {
            expect(start).toBeGreaterThanOrEqual(0);
            expect(start).toBeLessThan(end);
            expect(end).toBeLessThanOrEqual(b.length);
          }
        }
      }),
    );
  });

  it("answers the empty files", () => {
    expect([...aligned("", "").oldOfNew]).toEqual([]);
    expect([...aligned("", "a\n").oldOfNew]).toEqual([-1]);
    expect([...aligned("a\n", "").oldOfNew]).toEqual([]);
  });
});
