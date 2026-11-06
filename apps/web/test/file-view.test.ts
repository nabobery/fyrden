// What the file page computes before anything is drawn: what a file's bytes are, where its
// lines end (as the renderer counts them), the fixed blocks a large file is paged by, the
// line a link names and the links the page writes.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Block,
  blockHolding,
  fileState,
  gotoTarget,
  lineLink,
  MAX_WHOLE_BYTES,
  MAX_WHOLE_LINES,
  parseLineFragment,
  parseLineRange,
  rawBytesUrl,
  readLineLocation,
  scanBlocks,
  splitLines,
  withoutFinalEnding,
} from "../app/lib/file-view.js";
import { classifyBytes, decodeText } from "../app/lib/types.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const KIB_64 = 64 * 1024;

describe("what a file's bytes are", () => {
  it("is text when the bytes decode as UTF-8 and hold no NUL", () => {
    expect(classifyBytes(utf8("héllo\n"))).toEqual({ kind: "text", text: "héllo\n" });
    expect(classifyBytes(new Uint8Array())).toEqual({ kind: "text", text: "" });
  });

  it("is binary with a NUL, whatever else the bytes are", () => {
    expect(classifyBytes(Uint8Array.of(0x61, 0x00, 0x62))).toEqual({ kind: "binary" });
    expect(classifyBytes(Uint8Array.of(0xff, 0x00))).toEqual({ kind: "binary" });
  });

  it("is undecodable when valid bytes are not UTF-8", () => {
    expect(classifyBytes(Uint8Array.of(0xc3, 0x28))).toEqual({ kind: "undecodable" });
    // Cut in the middle of a character.
    expect(classifyBytes(utf8("é").subarray(0, 1))).toEqual({ kind: "undecodable" });
  });

  it("keeps decodeText's answer for its callers", () => {
    expect(decodeText(btoa("hi"))).toBe("hi");
    expect(decodeText(btoa("a\0b"))).toBeUndefined();
    expect(decodeText(btoa("\xc3\x28"))).toBeUndefined();
    // A byte order mark is taken off, as it always was.
    expect(decodeText(btoa("\xef\xbb\xbfhi"))).toBe("hi");
  });
});

describe("a file's lines", () => {
  it("ends a line at each of LF, CR-LF and a lone CR", () => {
    expect(splitLines("a\nb\r\nc\rd")).toEqual(["a", "b", "c", "d"]);
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("a\n")).toEqual(["a", ""]);
    expect(splitLines("\r\n\r")).toEqual(["", "", ""]);
  });

  it("takes off one final line ending, of any kind", () => {
    expect(withoutFinalEnding("a\n")).toBe("a");
    expect(withoutFinalEnding("a\r\n")).toBe("a");
    expect(withoutFinalEnding("a\r")).toBe("a");
    expect(withoutFinalEnding("a\n\n")).toBe("a\n");
    expect(withoutFinalEnding("a\r\r\n")).toBe("a\r");
    expect(withoutFinalEnding("a")).toBe("a");
    expect(withoutFinalEnding("")).toBe("");
  });

  it("numbers a file's lines with its final ending off", () => {
    const counts: [string, number][] = [
      ["a\n", 1],
      ["a", 1],
      ["\n", 1],
      ["a\n\n", 2],
      ["a\r\nb\r\n", 2],
      ["a\rb", 2],
      ["a\rb\r", 2],
      ["a\r\rb\n\nc", 5],
    ];
    for (const [text, lines] of counts)
      expect(splitLines(withoutFinalEnding(text)).length, JSON.stringify(text)).toBe(lines);
  });
});

/** `lines` joined by `\n`, with no final ending: what the scan is given. */
const joined = (lines: string[]) => lines.join("\n");
const shape = ({ firstLine, lineCount, cut }: Block) => ({ firstLine, lineCount, cut });

describe("a file's blocks", () => {
  it("has one block for a small file, and for an empty text", () => {
    expect(scanBlocks("a\nb").blocks.map(shape)).toEqual([
      { firstLine: 1, lineCount: 2, cut: false },
    ]);
    const empty = scanBlocks("");
    expect(empty.totalLines).toBe(1);
    expect(empty.blocks.map(shape)).toEqual([{ firstLine: 1, lineCount: 1, cut: false }]);
  });

  it("ends a block at 2,000 lines", () => {
    const { blocks, totalLines } = scanBlocks(joined(Array.from({ length: 4_001 }, () => "x")));
    expect(totalLines).toBe(4_001);
    expect(blocks.map(shape)).toEqual([
      { firstLine: 1, lineCount: 2_000, cut: false },
      { firstLine: 2_001, lineCount: 2_000, cut: false },
      { firstLine: 4_001, lineCount: 1, cut: false },
    ]);
  });

  it("ends a block when the next line would take it past 64 KiB", () => {
    // 1 KiB with its LF: 64 lines fill a block exactly, and the 65th starts the next.
    const line = "x".repeat(1_023);
    const { blocks } = scanBlocks(joined(Array.from({ length: 65 }, () => line)));
    expect(blocks.map((b) => b.firstLine)).toEqual([1, 65]);
    expect(blocks[0]?.lineCount).toBe(64);
  });

  it("counts bytes, not characters", () => {
    // Each is 3 bytes and one UTF-16 unit, and with its LF a line is 1,024 bytes.
    const line = `${"€".repeat(341)}`;
    const { blocks } = scanBlocks(joined(Array.from({ length: 65 }, () => line)));
    expect(blocks[0]?.lineCount).toBe(64);
  });

  it("puts a line over 64 KiB in a block of its own, cut and marked", () => {
    const long = "y".repeat(KIB_64 + 5);
    const text = joined(["before", long, "after"]);
    const { blocks, totalLines } = scanBlocks(text);
    expect(totalLines).toBe(3);
    expect(blocks.map(shape)).toEqual([
      { firstLine: 1, lineCount: 1, cut: false },
      { firstLine: 2, lineCount: 1, cut: true },
      { firstLine: 3, lineCount: 1, cut: false },
    ]);
    expect(text.slice(blocks[1]?.start, blocks[1]?.end)).toBe("y".repeat(KIB_64));
  });

  it("does not call a line of exactly 64 KiB cut", () => {
    const { blocks } = scanBlocks("z".repeat(KIB_64));
    expect(blocks.map(shape)).toEqual([{ firstLine: 1, lineCount: 1, cut: false }]);
  });

  it("cuts a long line between characters, never inside one", () => {
    const long = "😀".repeat(KIB_64);
    const { blocks } = scanBlocks(long);
    const shown = long.slice(blocks[0]?.start, blocks[0]?.end);
    expect(blocks[0]?.cut).toBe(true);
    expect(utf8(shown).length).toBe(KIB_64);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(utf8(shown))).toBe(shown);
  });

  it("counts mixed endings as one line each, and never splits a CR-LF pair", () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `${i}`);
    // Line 2,000 ends in CR-LF, right at the boundary.
    const text = `${lines.join("\r\n")}\r\nnext\rlast`;
    const { blocks, totalLines } = scanBlocks(text);
    expect(totalLines).toBe(2_002);
    expect(blocks.map((b) => b.firstLine)).toEqual([1, 2_001]);
    expect(text.slice(blocks[1]?.start, blocks[1]?.end)).toBe("next\rlast");
    expect(text.slice(blocks[0]?.start, blocks[0]?.end).endsWith("1999")).toBe(true);
  });

  it("counts a line's ending towards its block", () => {
    // 1 KiB with its CR-LF: 64 lines fill a block exactly, as with an LF above.
    const line = "x".repeat(1_022);
    const { blocks } = scanBlocks(Array.from({ length: 65 }, () => line).join("\r\n"));
    expect(blocks[0]?.lineCount).toBe(64);
  });

  it("finds the block holding a line", () => {
    const { blocks } = scanBlocks(joined(Array.from({ length: 4_500 }, () => "x")));
    expect(blockHolding(blocks, 1).firstLine).toBe(1);
    expect(blockHolding(blocks, 2_000).firstLine).toBe(1);
    expect(blockHolding(blocks, 2_001).firstLine).toBe(2_001);
    expect(blockHolding(blocks, 4_500).firstLine).toBe(4_001);
    expect(blockHolding(blocks, 99_999).firstLine).toBe(4_001);
  });

  it("covers every line once, in order, within the limits, on any text", () => {
    const line = fc.oneof(
      fc.string({ maxLength: 8 }).map((s) => s.replace(/[\r\n]/g, "")),
      fc.constant("x".repeat(30_000)),
      fc.constant("é".repeat(40_000)),
    );
    const ending = fc.constantFrom("\n", "\r\n", "\r");
    const text = fc
      .array(fc.tuple(line, ending), { maxLength: 40 })
      .map((parts) => parts.flat().join(""));
    fc.assert(
      fc.property(text, (source) => {
        const contents = withoutFinalEnding(source);
        const { blocks, totalLines } = scanBlocks(contents);
        expect(totalLines).toBe(splitLines(contents).length);
        let next = 1;
        for (const block of blocks) {
          expect(block.firstLine).toBe(next);
          next += block.lineCount;
          expect(block.lineCount).toBeLessThanOrEqual(MAX_WHOLE_LINES);
          const shown = contents.slice(block.start, block.end);
          expect(splitLines(shown).length).toBe(block.lineCount);
          expect(utf8(shown).length).toBeLessThanOrEqual(MAX_WHOLE_BYTES);
        }
        expect(next - 1).toBe(totalLines);
      }),
      { numRuns: 50 },
    );
  });
});

describe("the line a link names", () => {
  it("reads a line and a range", () => {
    expect(parseLineRange("12", 100)).toEqual({ start: 12, end: 12 });
    expect(parseLineRange("12-20", 100)).toEqual({ start: 12, end: 20 });
  });

  it("swaps a reversed range", () => {
    expect(parseLineRange("20-12", 100)).toEqual({ start: 12, end: 20 });
  });

  it("clamps what is out of range", () => {
    expect(parseLineRange("0", 100)).toEqual({ start: 1, end: 1 });
    expect(parseLineRange("90-200", 100)).toEqual({ start: 90, end: 100 });
    expect(parseLineRange("500-600", 100)).toEqual({ start: 100, end: 100 });
    expect(parseLineRange("9".repeat(400), 100)).toEqual({ start: 100, end: 100 });
  });

  it("ignores anything else", () => {
    for (const value of [
      null,
      "",
      " 1",
      "a",
      "1-",
      "-1",
      "1-2-3",
      "1.5",
      "1e3",
      "+1",
      "0x10",
      "L1",
    ])
      expect(parseLineRange(value, 100), String(value)).toBeNull();
  });

  it("reads a fragment by the same rule", () => {
    expect(parseLineFragment("#L12", 100)).toEqual({ start: 12, end: 12 });
    expect(parseLineFragment("#L12-L20", 100)).toEqual({ start: 12, end: 20 });
    expect(parseLineFragment("#L20-L12", 100)).toEqual({ start: 12, end: 20 });
    expect(parseLineFragment("#L900", 100)).toEqual({ start: 100, end: 100 });
    for (const hash of ["", "#", "#12", "#L", "#Lx", "#L1-2", "#L12-", "#top"])
      expect(parseLineFragment(hash, 100), hash).toBeNull();
  });

  it("always gives a range inside the file, or nothing", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 100_000 }), (value, total) => {
        const range = parseLineRange(value, total);
        if (range === null) return;
        expect(range.start).toBeGreaterThanOrEqual(1);
        expect(range.end).toBeGreaterThanOrEqual(range.start);
        expect(range.end).toBeLessThanOrEqual(total);
      }),
    );
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.integer({ min: 1, max: 100_000 }), (a, b, total) => {
        const range = parseLineRange(`${a}-${b}`, total);
        expect(range).not.toBeNull();
        expect(range?.start).toBeGreaterThanOrEqual(1);
        expect(range?.end).toBeLessThanOrEqual(total);
      }),
    );
  });
});

describe("the links the page writes", () => {
  it("writes a line and a range, always with both parts", () => {
    expect(lineLink({ start: 12, end: 12 }, false)).toBe("?line=12#L12");
    expect(lineLink({ start: 12, end: 20 }, false)).toBe("?line=12-20#L12");
  });

  it("keeps plain=1 on a Markdown file's source", () => {
    expect(lineLink({ start: 12, end: 12 }, true)).toBe("?plain=1&line=12#L12");
    expect(lineLink({ start: 12, end: 20 }, true)).toBe("?plain=1&line=12-20#L12");
  });

  it("writes no line for no selection", () => {
    expect(lineLink(null, false)).toBe("");
    expect(lineLink(null, true)).toBe("?plain=1");
  });

  it("ends a raw URL in a slash, so a name ending in .data stays a file", () => {
    expect(rawBytesUrl("ada", "demo", "a".repeat(40), "docs/notes.data")).toBe(
      `/ada/demo/raw/${"a".repeat(40)}/docs/notes.data/`,
    );
    expect(rawBytesUrl("ada", "demo", "topic/next", "a b/c#d")).toBe(
      "/ada/demo/raw/topic%2Fnext/a%20b/c%23d/",
    );
  });
});

describe("where a URL opens the file", () => {
  const at = (search: string, hash = "") => readLineLocation({ search, hash, total: 5_000 });

  it("selects the query's lines and goes to the first", () => {
    expect(at("?line=12")).toEqual({
      selection: { start: 12, end: 12 },
      position: 12,
      canonical: null,
    });
    expect(at("?line=12-20", "#L12")).toEqual({
      selection: { start: 12, end: 20 },
      position: 12,
      canonical: null,
    });
  });

  it("takes a hand-written fragment, and rewrites the URL as canonical", () => {
    expect(at("", "#L12")).toEqual({
      selection: { start: 12, end: 12 },
      position: 12,
      canonical: "?line=12#L12",
    });
    expect(at("?plain=1", "#L12-L20")).toEqual({
      selection: { start: 12, end: 20 },
      position: 12,
      canonical: "?plain=1&line=12-20#L12",
    });
  });

  it("lets any other fragment win over the query", () => {
    expect(at("?line=12-20", "#L30")).toEqual({
      selection: { start: 30, end: 30 },
      position: 30,
      canonical: "?line=30#L30",
    });
    // A range is no canonical fragment, even one that starts where the query's does.
    expect(at("?line=12-20", "#L12-L15")).toEqual({
      selection: { start: 12, end: 15 },
      position: 12,
      canonical: "?line=12-15#L12",
    });
  });

  it("keeps the query when the fragment means nothing", () => {
    expect(at("?line=12", "#readme")).toEqual({
      selection: { start: 12, end: 12 },
      position: 12,
      canonical: null,
    });
    expect(at("", "#readme")).toEqual({ selection: null, position: null, canonical: null });
  });

  it("keeps position apart from selection", () => {
    expect(at("?from=2001&line=1999-2002")).toEqual({
      selection: { start: 1999, end: 2002 },
      position: 2001,
      canonical: null,
    });
    expect(at("?from=4001")).toEqual({ selection: null, position: 4001, canonical: null });
    expect(at("?from=9999")).toEqual({ selection: null, position: 5000, canonical: null });
    expect(at("?from=abc&line=7")).toEqual({
      selection: { start: 7, end: 7 },
      position: 7,
      canonical: null,
    });
  });

  it("drops from when a fragment rewrites the URL", () => {
    expect(at("?from=2001&line=5", "#L9").canonical).toBe("?line=9#L9");
  });
});

describe("the go-to-line target", () => {
  const url = (search: string, path = "/ada/demo/blob/main/a.ts") =>
    new URL(`https://fyrden.test${path}${search}`);

  it("goes to the line, as a canonical link", () => {
    expect(gotoTarget(url("?goto=12"), 100)).toBe("/ada/demo/blob/main/a.ts?line=12#L12");
  });

  it("clamps to the last line", () => {
    expect(gotoTarget(url("?goto=500"), 100)).toBe("/ada/demo/blob/main/a.ts?line=100#L100");
    expect(gotoTarget(url(`?goto=${"9".repeat(400)}`), 100)).toBe(
      "/ada/demo/blob/main/a.ts?line=100#L100",
    );
  });

  it("keeps plain=1, and drops goto, from and any line before it", () => {
    expect(gotoTarget(url("?plain=1&from=2001&line=3&goto=12"), 100)).toBe(
      "/ada/demo/blob/main/a.ts?plain=1&line=12#L12",
    );
  });

  it("goes nowhere for anything but a positive integer", () => {
    const hostile = [
      "",
      "0",
      "-1",
      "1.5",
      "1e3",
      "+1",
      "0x10",
      "12%23L3",
      "L12",
      "%0d%0aSet-Cookie:x=1",
      "//evil.test",
      "https://evil.test/",
      "%3Cscript%3E",
      "1-5",
    ];
    for (const value of hostile) {
      const target = gotoTarget(url(`?plain=1&line=3&goto=${value}`), 100);
      expect(target, value).toBe("/ada/demo/blob/main/a.ts?plain=1");
    }
    expect(gotoTarget(url("?goto=abc"), 100)).toBe("/ada/demo/blob/main/a.ts");
  });

  it("goes nowhere on a file with no numbered lines", () => {
    expect(gotoTarget(url("?goto=12"), null)).toBe("/ada/demo/blob/main/a.ts");
  });

  it("opens a name ending in .data by its slash, so the answer is the page", () => {
    expect(gotoTarget(url("?goto=2", "/ada/demo/blob/main/notes.data"), 3)).toBe(
      "/ada/demo/blob/main/notes.data/?line=2#L2",
    );
    expect(gotoTarget(url("?goto=2", "/ada/demo/blob/main/notes.data/"), 3)).toBe(
      "/ada/demo/blob/main/notes.data/?line=2#L2",
    );
  });
});

describe("a file's state", () => {
  const SHA = "b".repeat(40);
  const COMMIT = "c".repeat(40);
  const file = (bytes: Uint8Array | string, extra: Record<string, unknown> = {}) => {
    const raw = typeof bytes === "string" ? utf8(bytes) : bytes;
    return {
      type: "file" as const,
      path: "a.ts",
      name: "a.ts",
      sha: SHA,
      mode: "100644",
      size: raw.length,
      encoding: "base64" as const,
      content: btoa(String.fromCharCode(...raw)),
      download_url: `https://fyrden.test/api/repos/ada/demo/raw/a.ts?ref=${COMMIT}`,
      ...extra,
    };
  };
  const stateOf = (contents: Parameters<typeof fileState>[0], search = "") =>
    fileState(contents, new URLSearchParams(search));

  it("names each kind of file", () => {
    expect(stateOf(file("")).state).toBe("empty");
    expect(stateOf(file("a\n")).state).toBe("text");
    expect(stateOf(file(Uint8Array.of(0x61, 0)))).toEqual({ state: "binary" });
    expect(stateOf(file(Uint8Array.of(0xc3, 0x28)))).toEqual({ state: "undecodable" });
  });

  it("says too large from the answer alone, having inspected nothing", () => {
    const big = (size: number) => file("", { size, encoding: "none", content: "" });
    expect(stateOf(big(2 * 1024 * 1024))).toEqual({ state: "too-large" });
    expect(stateOf(big(24 * 1024 * 1024))).toEqual({ state: "too-large" });
    expect(stateOf(big(24 * 1024 * 1024 + 1))).toEqual({ state: "too-large-for-raw" });
  });

  it("names a submodule's commit and a symlink's target", () => {
    expect(stateOf({ type: "submodule", path: "s", name: "s", sha: SHA })).toEqual({
      state: "submodule",
      sha: SHA,
    });
    expect(
      stateOf({
        type: "symlink",
        path: "l",
        name: "l",
        sha: SHA,
        size: 1,
        target: "x",
        content: "",
      }),
    ).toEqual({ state: "symlink", target: "x" });
  });

  it("sends a small file whole, its final ending off", () => {
    expect(stateOf(file("a\nb\n"))).toMatchObject({
      state: "text",
      text: "a\nb",
      whole: true,
      firstLine: 1,
      totalLines: 2,
      previous: null,
      next: null,
      commit: COMMIT,
      sha: SHA,
      size: 4,
    });
  });

  it("keeps a whole file's selection, clamped", () => {
    expect(stateOf(file("a\nb\n"), "line=9")).toMatchObject({ selected: { start: 2, end: 2 } });
    expect(stateOf(file("a\nb\n"), "line=x")).toMatchObject({ selected: null });
  });

  /** `count` short lines, as a file: its bytes, and the size the API gives for them. */
  const manyLines = (count: number) => {
    const text = Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
    return { ...file("x"), size: utf8(text).length, content: btoa(text) };
  };

  it("sends the first block of what is over 2,000 lines, with the commit to read the rest at", () => {
    const state = stateOf(manyLines(4_500));
    expect(state).toMatchObject({
      state: "text",
      whole: false,
      firstLine: 1,
      totalLines: 4_500,
      previous: null,
      next: 2_001,
      commit: COMMIT,
    });
    if (state.state !== "text") throw new Error(state.state);
    expect(splitLines(state.text).length).toBe(2_000);
    expect(splitLines(state.text).at(-1)).toBe("line 2000");
  });

  it("sends a file of exactly 2,000 lines whole, and one more not", () => {
    expect(stateOf(manyLines(2_000))).toMatchObject({ whole: true, totalLines: 2_000 });
    expect(stateOf(manyLines(2_001))).toMatchObject({ whole: false, totalLines: 2_001 });
  });

  it("sends a file of exactly 64 KiB whole, and one byte more not", () => {
    const of = (size: number) => ({ ...file("x"), size, content: btoa("x".repeat(size)) });
    expect(stateOf(of(KIB_64))).toMatchObject({ whole: true, cut: false });
    expect(stateOf(of(KIB_64 + 1))).toMatchObject({ whole: false, cut: true });
  });

  it("picks the block by from, else by the first line of line", () => {
    const big = manyLines(4_500);
    expect(stateOf(big, "line=4100")).toMatchObject({
      firstLine: 4_001,
      previous: 2_001,
      next: null,
    });
    expect(stateOf(big, "from=2500")).toMatchObject({ firstLine: 2_001, previous: 1, next: 4_001 });
    expect(stateOf(big, "from=2001&line=1999-2002")).toMatchObject({
      firstLine: 2_001,
      selected: { start: 1999, end: 2002 },
    });
    expect(stateOf(big, "line=1999-2002")).toMatchObject({ firstLine: 1 });
  });

  it("takes the last block past the end, the first for what is invalid", () => {
    const big = manyLines(4_500);
    expect(stateOf(big, "from=99999")).toMatchObject({ firstLine: 4_001 });
    expect(stateOf(big, "line=99999")).toMatchObject({ firstLine: 4_001 });
    expect(stateOf(big, "from=abc")).toMatchObject({ firstLine: 1 });
    expect(stateOf(big, "from=0")).toMatchObject({ firstLine: 1 });
    expect(stateOf(big, "from=-3&line=4100")).toMatchObject({ firstLine: 1 });
    expect(stateOf(big, "line=abc")).toMatchObject({ firstLine: 1 });
  });

  it("has no commit to read the rest at when the answer's URL names none", () => {
    const state = stateOf({ ...manyLines(4_500), download_url: "not a url" });
    expect(state).toMatchObject({ whole: false, commit: null });
  });
});
