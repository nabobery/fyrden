// Blame's own lines: numbered at line feeds only, as the engine counts them, so the page's
// numbers are the API's. Its windows, its targets, and how ranges are drawn as groups.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  authorDate,
  BLAME_LIMIT_LINES,
  blameBlocks,
  blameTarget,
  blameWindow,
  decodeBlameBytes,
  displayGroups,
  drawnLines,
  hasLoneCr,
  type Range,
  unresolvedSentence,
} from "../app/lib/blame.js";
import { MAX_WHOLE_BYTES, MAX_WHOLE_LINES } from "../app/lib/file-view.js";

/** The engine's own count (`countLines`, packages/git-core/src/blame/walk.ts), copied. */
function engineLines(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) count++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) count++;
  return count;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const lines = (text: string) => blameBlocks(text).totalLines;
const decoded = (text: string) => {
  const read = decodeBlameBytes(utf8(text));
  if (read.kind !== "text") throw new Error(read.kind);
  return read.text;
};

describe("counting lines as blame does", () => {
  it.each([
    ["the empty file", "", 0],
    ["one empty line", "\n", 1],
    ["a trailing line feed", "a\nb\n", 2],
    ["no trailing line feed", "a\nb", 2],
    ["a trailing carriage return", "a\r", 1],
    ["a carriage return ending the last line", "a\nb\r", 2],
    ["CRLF endings", "a\r\nb\r\n", 2],
    ["mixed endings", "a\r\nb\rc\n", 2],
    ["a lone carriage return inside a line", "a\rb", 1],
  ])("counts %s", (_name, text, expected) => {
    expect(lines(text)).toBe(expected);
    expect(lines(text)).toBe(engineLines(utf8(text)));
  });

  it("keeps a byte order mark, so a file holding only one has its one line", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const read = decodeBlameBytes(bom);
    expect(read).toEqual({ kind: "text", text: "﻿" });
    expect(lines("﻿")).toBe(engineLines(bom));
    expect(decoded("﻿a\nb\n")).toBe("﻿a\nb\n");
    expect(lines(decoded("﻿a\nb\n"))).toBe(2);
  });

  it("tells text from binary and from bytes that aren't UTF-8", () => {
    expect(decodeBlameBytes(utf8("a\0b")).kind).toBe("binary");
    expect(decodeBlameBytes(new Uint8Array([0xc3, 0x28])).kind).toBe("undecodable");
  });

  it("agrees with the engine on any mix of line endings", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "é", "\r", "\n", "\r\n")), (parts) => {
        const text = parts.join("");
        expect(lines(text)).toBe(engineLines(utf8(text)));
      }),
      { numRuns: 2_000 },
    );
  });
});

describe("a lone carriage return", () => {
  it.each([
    ["none in LF text", "a\nb\n", false],
    ["none in CRLF text", "a\r\nb\r\n", false],
    ["one inside a line", "a\rb\n", true],
    ["one ending the file", "a\nb\r", true],
    ["one before a CRLF", "a\r\r\n", true],
  ])("is found: %s", (_name, text, expected) => {
    expect(hasLoneCr(text)).toBe(expected);
  });
});

describe("the lines drawn", () => {
  it("draws CRLF lines without their CR, and any other CR as ␍", () => {
    const text = "a\r\nb\rc\nd\r";
    const { blocks } = blameBlocks(text);
    expect(drawnLines(text, blocks[0] as never)).toEqual([
      { number: 1, text: "a" },
      { number: 2, text: "b␍c" },
      { number: 3, text: "d␍" },
    ]);
  });

  it("draws one empty line for a file that is only a line feed", () => {
    const { blocks } = blameBlocks("\n");
    expect(drawnLines("\n", blocks[0] as never)).toEqual([{ number: 1, text: "" }]);
  });
});

describe("windows", () => {
  it("has no blocks for the empty file", () => {
    expect(blameBlocks("")).toEqual({ blocks: [], totalLines: 0 });
  });

  it(`ends a block at ${MAX_WHOLE_LINES} lines`, () => {
    const text = "x\n".repeat(MAX_WHOLE_LINES + 1);
    const { blocks, totalLines } = blameBlocks(text);
    expect(totalLines).toBe(MAX_WHOLE_LINES + 1);
    expect(blocks.map((b) => [b.firstLine, b.lineCount])).toEqual([
      [1, MAX_WHOLE_LINES],
      [MAX_WHOLE_LINES + 1, 1],
    ]);
  });

  it("ends a block before a line that would take it past 64 KiB, its ending counted", () => {
    // 3 lines of 32,767 bytes and an LF: two fill 65,536 bytes exactly, the third starts a block.
    const line = `${"y".repeat(32_767)}\n`;
    const { blocks } = blameBlocks(line.repeat(3));
    expect(blocks.map((b) => [b.firstLine, b.lineCount])).toEqual([
      [1, 2],
      [3, 1],
    ]);
  });

  it("counts a carriage return as a byte of its line", () => {
    const line = `${"y".repeat(32_766)}\r\n`;
    const { blocks } = blameBlocks(line.repeat(3));
    expect(blocks.map((b) => b.lineCount)).toEqual([2, 1]);
  });

  it("cuts a line longer than a block, alone in its block", () => {
    const text = `a\n${"z".repeat(MAX_WHOLE_BYTES + 10)}\nb\n`;
    const { blocks } = blameBlocks(text);
    expect(blocks.map((b) => [b.firstLine, b.lineCount, b.cut])).toEqual([
      [1, 1, false],
      [2, 1, true],
      [3, 1, false],
    ]);
    const cut = drawnLines(text, blocks[1] as never);
    expect(cut).toHaveLength(1);
    expect(new TextEncoder().encode(cut[0]?.text).length).toBe(MAX_WHOLE_BYTES);
  });
});

describe("the line a page opens at", () => {
  const target = (query: string) => blameTarget(new URLSearchParams(query));

  it.each([
    ["nothing", "", 1],
    ["from", "from=2001", 2001],
    ["from with leading zeros", "from=0042", 42],
    ["from over line", "from=10&line=500", 10],
    ["line", "line=12", 12],
    ["a range", "line=12-20", 12],
    ["a reversed range", "line=4000-2", 2],
    ["an invalid from, falling back to 1", "from=x&line=30", 1],
    ["zero", "from=0", 1],
    ["a sign", "from=-5", 1],
    ["text", "line=abc", 1],
    ["a number past blame's limit", "from=100001", BLAME_LIMIT_LINES],
    ["an unsafe number", "from=9007199254740992", BLAME_LIMIT_LINES],
    ["hundreds of digits", `line=${"9".repeat(400)}`, BLAME_LIMIT_LINES],
  ])("takes %s", (_name, query, expected) => {
    expect(target(query)).toBe(expected);
  });

  it("asks for a window that holds any block containing the target, within 5,000 lines", () => {
    for (const t of [1, 2, 1999, 2000, 2001, 50_000, BLAME_LIMIT_LINES]) {
      const { start, end } = blameWindow(t);
      expect(start).toBe(Math.max(1, t - (MAX_WHOLE_LINES - 1)));
      expect(end).toBe(t + MAX_WHOLE_LINES - 1);
      expect(end - start).toBeLessThan(5_000);
      expect(Number.isSafeInteger(end)).toBe(true);
    }
  });
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const commit = (start: number, count: number, sha: string, source = start): Range => ({
  start_line: start,
  line_count: count,
  commit: sha,
  source_start_line: source,
});
const refused = (start: number, count: number, reason: string): Range =>
  ({ start_line: start, line_count: count, unresolved: reason }) as Range;

describe("display groups", () => {
  it("merges adjacent ranges of one commit, whatever their source lines", () => {
    expect(
      displayGroups([commit(1, 2, A, 10), commit(3, 1, A, 50), commit(4, 1, B)], 1, 4),
    ).toEqual([
      { kind: "commit", commit: A, startLine: 1, lineCount: 3 },
      { kind: "commit", commit: B, startLine: 4, lineCount: 1 },
    ]);
  });

  it("merges adjacent unresolved lines of one reason, and keeps reasons apart", () => {
    expect(
      displayGroups(
        [refused(1, 1, "diff_budget"), refused(2, 2, "diff_budget"), refused(4, 1, "object_limit")],
        1,
        4,
      ),
    ).toEqual([
      { kind: "unresolved", reason: "diff_budget", startLine: 1, lineCount: 3 },
      { kind: "unresolved", reason: "object_limit", startLine: 4, lineCount: 1 },
    ]);
  });

  it("makes each stretch no range covers pending, in any order the ranges came", () => {
    expect(displayGroups([commit(6, 2, B), commit(3, 1, A)], 1, 9)).toEqual([
      { kind: "pending", startLine: 1, lineCount: 2 },
      { kind: "commit", commit: A, startLine: 3, lineCount: 1 },
      { kind: "pending", startLine: 4, lineCount: 2 },
      { kind: "commit", commit: B, startLine: 6, lineCount: 2 },
      { kind: "pending", startLine: 8, lineCount: 2 },
    ]);
  });

  it("clips ranges to the lines asked for", () => {
    expect(displayGroups([commit(1, 10, A), commit(11, 5, B)], 8, 12)).toEqual([
      { kind: "commit", commit: A, startLine: 8, lineCount: 3 },
      { kind: "commit", commit: B, startLine: 11, lineCount: 2 },
    ]);
  });

  it("has no groups for no lines", () => {
    expect(displayGroups([], 1, 0)).toEqual([]);
  });
});

describe("why a line isn't attributed", () => {
  it.each([
    "parent_too_large",
    "too_many_parents",
    "diff_budget",
    "slide_unsettled",
    "object_limit",
    "work_limit",
    "history_unreadable",
    "history_missing",
    "history_limit",
    "state_limit",
    "commit_info_too_large",
    "rename_possible",
    "step_lost",
  ])("says it for %s, in words", (reason) => {
    const sentence = unresolvedSentence(reason);
    expect(sentence).toMatch(/^(Not attributed|Some lines could not be attributed)/);
    expect(sentence).not.toContain(reason);
  });

  it("gives the two size and work refusals their own sentences", () => {
    expect(unresolvedSentence("object_limit")).toBe(
      "Some lines could not be attributed because reading their history requires an object larger than Fyrden's 4 MiB blame limit. The current file may be smaller. Resolved lines remain shown.",
    );
    expect(unresolvedSentence("work_limit")).toBe(
      "Some lines could not be attributed because reading their history takes more reads or decoding than one request allows. Asking again won't change this. Resolved lines remain shown.",
    );
  });

  it("names a reason it doesn't know", () => {
    expect(unresolvedSentence("something_new")).toBe("Not attributed (something_new).");
  });
});

describe("an author's date", () => {
  it.each([
    ["1700000000 +0000", "2023-11-14"],
    // 22:13 UTC is the next day at +0200 and still the same day at -0500.
    ["1700000000 +0200", "2023-11-15"],
    ["1700000000 -0500", "2023-11-14"],
    ["not a date", "not a date"],
  ])("reads %s as %s", (date, expected) => {
    expect(authorDate(date)).toBe(expected);
  });
});
