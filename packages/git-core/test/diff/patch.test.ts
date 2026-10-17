import { describe, expect, it } from "vitest";
import { diffFile, type FileDiff } from "../../src/diff/file-diff.js";
import { hunksOf } from "../../src/diff/hunks.js";
import { diffSequences } from "../../src/diff/line-diff.js";
import { formatFileHeader, quotePath } from "../../src/diff/patch.js";
import { internLines, isBinary, lineAt, splitLines } from "../../src/diff/text.js";

const enc = new TextEncoder();
const text = (lines: string[]) => enc.encode(lines.join(""));
const asText = (diff: FileDiff) => (diff.kind === "text" ? diff.text : diff.kind);

describe("splitLines and internLines", () => {
  it("keeps each line's line feed, and a last line without one", () => {
    const lines = splitLines(enc.encode("a\nb")) ?? expect.fail();
    expect([lineAt(lines, 0), lineAt(lines, 1)].map((l) => new TextDecoder().decode(l))).toEqual([
      "a\n",
      "b",
    ]);
    expect(splitLines(enc.encode(""))?.count).toBe(0);
    expect(splitLines(enc.encode("\n\n"))?.count).toBe(2);
  });

  it("refuses more lines than the budget", () => {
    expect(splitLines(enc.encode("\n".repeat(11)), 10)).toBeUndefined();
    expect(splitLines(enc.encode("\n".repeat(10)), 10)?.count).toBe(10);
  });

  it("gives equal lines equal ids, telling a line with a line feed from one without", () => {
    const a = splitLines(enc.encode("x\ny\n")) ?? expect.fail();
    const b = splitLines(enc.encode("y\nx")) ?? expect.fail();
    const ids = internLines(a, b);
    expect([...ids.a]).toEqual([0, 1]);
    expect([...ids.b]).toEqual([1, 2]);
  });

  it("calls content with a NUL in its first 8,000 bytes binary", () => {
    expect(isBinary(new Uint8Array([97, 0]))).toBe(true);
    const late = new Uint8Array(8_001).fill(97);
    late[8_000] = 0;
    expect(isBinary(late)).toBe(false);
  });
});

describe("hunksOf", () => {
  const ids = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it("keeps three lines of context and joins changes close together", () => {
    const a = ids("abcdefghijklmnop");
    const hunks = hunksOf(diffSequences(a, ids("abcXefghijYlmnop")).edits);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 14, newStart: 1, newLines: 14 });
    const apart = hunksOf(diffSequences(a, ids("aXcdefghijklmnoY")).edits);
    expect(apart.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 5, 1, 5],
      [13, 4, 13, 4],
    ]);
  });

  it("names the line before an empty range", () => {
    const hunks = hunksOf(diffSequences(ids("abc"), ids("abXc")).edits, 0);
    expect(hunks).toEqual([
      { oldStart: 2, oldLines: 0, newStart: 3, newLines: 1, lines: [{ kind: "+", index: 2 }] },
    ]);
  });
});

describe("diffFile and its patch", () => {
  it("writes hunk headers, lines and the no-newline marker", () => {
    const diff = diffFile(text(["a\n", "b\n", "c"]), text(["a\n", "B\n", "c\n"]));
    expect(diff).toMatchObject({ kind: "text", approximate: false, additions: 2, deletions: 2 });
    expect(asText(diff)).toBe(
      "@@ -1,3 +1,3 @@\n a\n-b\n-c\n\\ No newline at end of file\n+B\n+c\n",
    );
  });

  it("writes one-line ranges without a count", () => {
    expect(asText(diffFile(text(["a\n"]), text(["b\n"])))).toBe("@@ -1 +1 @@\n-a\n+b\n");
  });

  it("keeps the repository's bytes in the patch: a byte order mark, invalid UTF-8", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]);
    const invalid = new Uint8Array([0xff, 0x0a]);
    const diff = diffFile(bom, invalid);
    if (diff.kind !== "text") return expect.fail();
    expect([...diff.patch]).toEqual([...enc.encode("@@ -1 +1 @@\n-"), ...bom, 0x2b, ...invalid]);
    expect(diff.text).toBe("@@ -1 +1 @@\n-﻿a\n+�\n");
  });

  it("says binary for a NUL, and too large past the line budget", () => {
    expect(diffFile(new Uint8Array([1, 0, 2]), text(["x\n"])).kind).toBe("binary");
    expect(diffFile(text(["x\n"]), enc.encode("\n".repeat(11)), { maxLines: 10 }).kind).toBe(
      "too_large",
    );
  });
});

describe("file headers", () => {
  const p = (s: string) => enc.encode(s);
  const base = {
    oldMode: "100644",
    newMode: "100644",
    oldOid: "a".repeat(40),
    newOid: "b".repeat(40),
  };

  it("writes git's headers for added, removed, renamed, mode-changed and binary files", () => {
    expect(
      formatFileHeader({
        ...base,
        status: "added",
        oldPath: null,
        newPath: p("n"),
        oldMode: null,
        oldOid: null,
      }),
    ).toBe(
      "diff --git a/n b/n\nnew file mode 100644\nindex 0000000..bbbbbbb\n--- /dev/null\n+++ b/n\n",
    );
    expect(
      formatFileHeader({
        ...base,
        status: "removed",
        oldPath: p("o"),
        newPath: null,
        newMode: null,
        newOid: null,
      }),
    ).toBe(
      "diff --git a/o b/o\ndeleted file mode 100644\nindex aaaaaaa..0000000\n--- a/o\n+++ /dev/null\n",
    );
    expect(
      formatFileHeader({
        ...base,
        status: "renamed",
        oldPath: p("o"),
        newPath: p("n"),
        newOid: base.oldOid,
        similarity: 100,
      }),
    ).toBe("diff --git a/o b/n\nsimilarity index 100%\nrename from o\nrename to n\n");
    expect(
      formatFileHeader({
        ...base,
        status: "changed",
        oldPath: p("f"),
        newPath: p("f"),
        newMode: "100755",
        newOid: base.oldOid,
      }),
    ).toBe("diff --git a/f b/f\nold mode 100644\nnew mode 100755\n");
    expect(
      formatFileHeader({
        ...base,
        status: "modified",
        oldPath: p("f"),
        newPath: p("f"),
        binary: true,
      }),
    ).toBe("diff --git a/f b/f\nindex aaaaaaa..bbbbbbb 100644\nBinary files a/f and b/f differ\n");
  });

  it("quotes a path with a control character, a quote, a backslash or a byte of 0x80 or more", () => {
    expect(quotePath("a/", p("plain name.txt"))).toBe("a/plain name.txt");
    expect(quotePath("a/", p("tab\there"))).toBe('"a/tab\\there"');
    expect(quotePath("b/", p('q"\\\n'))).toBe('"b/q\\"\\\\\\n"');
    expect(quotePath("", new Uint8Array([0xc3, 0xa9, 0x7f]))).toBe('"\\303\\251\\177"');
  });
});
