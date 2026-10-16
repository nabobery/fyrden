import { describe, expect, it } from "vitest";
import { merge3 } from "../../src/merge/diff3.js";
import { mergeFiles, withConflictMarkers } from "../../src/merge/file-merge.js";
import {
  MergeBudget,
  MergeLimitError,
  mergeTrees,
  type NewObject,
  type TreeMerge,
} from "../../src/merge/merge-trees.js";
import { baseTreeOf, MAX_VIRTUAL_DEPTH } from "../../src/merge/virtual-base.js";
import { type Oid, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { parseTree, type TreeEntry } from "../../src/object/tree.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ids = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("merge3", () => {
  it("takes the side that changed a chunk, and either when both changed it alike", () => {
    const { chunks, conflicts } = merge3(ids("abcde"), ids("aXcde"), ids("abcdY"));
    expect(conflicts).toBe(0);
    expect(chunks.flatMap((c) => (c.kind === "clean" ? c.lines : []))).toEqual(ids("aXcdY"));
    expect(merge3(ids("abc"), ids("aXc"), ids("aXc")).conflicts).toBe(0);
  });

  it("gives a chunk both changed differently as a conflict with all three versions", () => {
    const { chunks, conflicts } = merge3(ids("abc"), ids("aXc"), ids("aYc"));
    expect(conflicts).toBe(1);
    expect(chunks).toEqual([
      { kind: "clean", lines: ids("a") },
      { kind: "conflict", base: ids("b"), ours: ids("X"), theirs: ids("Y") },
      { kind: "clean", lines: ids("c") },
    ]);
  });

  it("merges into empty sides and an empty base", () => {
    expect(merge3([], ids("ab"), []).chunks).toEqual([{ kind: "clean", lines: ids("ab") }]);
    expect(merge3([], ids("ab"), ids("cd")).conflicts).toBe(1);
    expect(merge3(ids("ab"), [], ids("ab")).chunks).toEqual([]);
  });

  it("gives clean lines in a row as one chunk, whichever side they came from", () => {
    expect(merge3(ids("abcde"), ids("aXcde"), ids("abcdY")).chunks).toEqual([
      { kind: "clean", lines: ids("aXcdY") },
    ]);
  });
});

describe("mergeFiles", () => {
  const m = (b: string, o: string, t: string) =>
    mergeFiles(enc.encode(b), enc.encode(o), enc.encode(t));

  it("returns merged bytes, or conflict regions as data", () => {
    const clean = m("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    expect(clean.kind === "clean" ? dec.decode(clean.bytes) : clean.kind).toBe("A\nb\nC\n");
    const conflict = m("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n");
    if (conflict.kind !== "conflict") return expect.fail(conflict.kind);
    expect(conflict.conflicts).toBe(1);
    expect(conflict.regions[1]).toEqual({
      base: [enc.encode("b\n")],
      ours: [enc.encode("X\n")],
      theirs: [enc.encode("Y\n")],
    });
  });

  it("writes a conflicted file with git's markers, ending each side with a line feed", () => {
    const conflict = m("a\nb\nc", "a\nX\nc", "a\nY");
    if (conflict.kind !== "conflict") return expect.fail(conflict.kind);
    const text = dec.decode(
      withConflictMarkers(
        conflict.regions,
        { ours: "feature", theirs: "main" },
        { base: enc.encode("a\nb\nc"), ours: enc.encode("a\nX\nc"), theirs: enc.encode("a\nY") },
      ),
    );
    expect(text).toBe("a\n<<<<<<< feature\nX\nc\n=======\nY\n>>>>>>> main\n");
  });

  it("refuses binary sides and sides over the line budget", () => {
    expect(mergeFiles(new Uint8Array([0]), enc.encode("a"), enc.encode("b")).kind).toBe("binary");
    expect(
      mergeFiles(enc.encode("\n\n\n"), enc.encode(""), enc.encode(""), { maxLines: 2 }).kind,
    ).toBe("too_large");
  });

  it("flags a merge approximate when a side's line diff ran past its cost bound, and only then", () => {
    const [base, ours] = [enc.encode("a\nb\nc\nd\n"), enc.encode("a\nX\nY\nd\n")];
    expect(mergeFiles(base, ours, base)).toEqual({
      kind: "clean",
      bytes: ours,
      approximate: false,
    });
    // Our side's two changed lines cost more than one step to align; theirs is the base.
    expect(mergeFiles(base, ours, base, { maxCost: 1 })).toEqual({
      kind: "clean",
      bytes: ours,
      approximate: true,
    });
  });
});

describe("withConflictMarkers", () => {
  const marked = (base: string, ours: string, theirs: string) => {
    const merged = mergeFiles(enc.encode(base), enc.encode(ours), enc.encode(theirs));
    if (merged.kind !== "conflict") return merged.kind;
    return dec.decode(
      withConflictMarkers(
        merged.regions,
        { ours: "ours", theirs: "theirs" },
        { base: enc.encode(base), ours: enc.encode(ours), theirs: enc.encode(theirs) },
      ),
    );
  };

  // Each expected file is what `git merge-file -p ours base theirs` writes.
  for (const [what, base, ours, theirs, expected] of [
    [
      "LF lines",
      "a\nb\nc\n",
      "a\nX\nc\n",
      "a\nY\nc\n",
      "a\n<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\nc\n",
    ],
    [
      "CRLF lines",
      "a\r\nb\r\nc\r\n",
      "a\r\nX\r\nc\r\n",
      "a\r\nY\r\nc\r\n",
      "a\r\n<<<<<<< ours\r\nX\r\n=======\r\nY\r\n>>>>>>> theirs\r\nc\r\n",
    ],
    [
      "a side that deleted the lines",
      "a\nb\nc\n",
      "a\nc\n",
      "a\nY\nc\n",
      "a\n<<<<<<< ours\n=======\nY\n>>>>>>> theirs\nc\n",
    ],
    [
      "a base of LF lines and sides of CRLF lines (LF markers)",
      "b\n",
      "o\r\n",
      "t\r\n",
      "<<<<<<< ours\no\r\n=======\nt\r\n>>>>>>> theirs\n",
    ],
    [
      "a CRLF base and our first line ending with a bare LF (LF markers)",
      "b\r\n",
      "o\n",
      "t\r\n",
      "<<<<<<< ours\no\n=======\nt\r\n>>>>>>> theirs\n",
    ],
    [
      "a CRLF base and their first line ending with a bare LF (LF markers)",
      "b\r\n",
      "o\r\n",
      "t\n",
      "<<<<<<< ours\no\r\n=======\nt\n>>>>>>> theirs\n",
    ],
    [
      "a CRLF base and our only line without a line feed (CRLF markers, and one after it)",
      "b\r\n",
      "o",
      "t\r\n",
      "<<<<<<< ours\r\no\r\n=======\r\nt\r\n>>>>>>> theirs\r\n",
    ],
    [
      "a CRLF base and our side empty (CRLF markers)",
      "b\r\n",
      "",
      "t\r\n",
      "<<<<<<< ours\r\n=======\r\nt\r\n>>>>>>> theirs\r\n",
    ],
    [
      "a base whose first line is an empty CRLF line",
      "\r\nb\r\n",
      "\r\nX\r\n",
      "\r\nY\r\n",
      "\r\n<<<<<<< ours\r\nX\r\n=======\r\nY\r\n>>>>>>> theirs\r\n",
    ],
    [
      "a base whose first line is an empty LF line and the rest CRLF (LF markers)",
      "\nb\r\n",
      "\no\r\n",
      "\nt\r\n",
      "\n<<<<<<< ours\no\r\n=======\nt\r\n>>>>>>> theirs\n",
    ],
    [
      "a base whose first line is CRLF and last LF (only the first counts)",
      "p\r\nb\n",
      "p\r\no\r\n",
      "p\r\nt\r\n",
      "p\r\n<<<<<<< ours\r\no\r\n=======\r\nt\r\n>>>>>>> theirs\r\n",
    ],
    [
      "a CRLF base and a clean line before the conflict ending with a bare LF (LF markers)",
      "p\r\nq\nb\r\n",
      "p\r\nq\no\r\n",
      "p\r\nq\nt\r\n",
      "p\r\nq\n<<<<<<< ours\no\r\n=======\nt\r\n>>>>>>> theirs\n",
    ],
    [
      "a CRLF base and the last clean line before the conflict ending with CRLF",
      "p\r\nq\nr\r\nb\r\n",
      "p\r\nq\nr\r\no\r\n",
      "p\r\nq\nr\r\nt\r\n",
      "p\r\nq\nr\r\n<<<<<<< ours\r\no\r\n=======\r\nt\r\n>>>>>>> theirs\r\n",
    ],
  ] as const)
    it(`writes git's file for ${what}`, () => {
      expect(marked(base, ours, theirs)).toBe(expected);
    });
});

// Trees and blobs by hex id, built here.
function store() {
  const objects = new Map<string, TreeEntry[] | Uint8Array>();
  let n = 0;
  const put = (value: TreeEntry[] | Uint8Array): Oid => {
    const oid = new Uint8Array(20) as Oid;
    new DataView(oid.buffer).setUint32(0, ++n);
    objects.set(oidToHex(oid), value);
    return oid;
  };
  // Equal content, equal id (as git's are).
  const blobs = new Map<string, Oid>();
  const blob = (text: string) => {
    let oid = blobs.get(text);
    if (!oid) {
      oid = put(enc.encode(text));
      blobs.set(text, oid);
    }
    return oid;
  };
  const tree = (entries: Record<string, { mode?: number; oid: Oid }>) =>
    put(
      Object.entries(entries)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, e]) => ({ name: enc.encode(name), mode: e.mode ?? 0o100644, oid: e.oid })),
    );
  // A tree of entries as given (names as bytes).
  const rawTree = (entries: TreeEntry[]) => put(entries);
  const source = {
    readTree: async (oid: Oid) => objects.get(oidToHex(oid)) as TreeEntry[],
    readBlob: async (oid: Oid, maxBytes: number) => {
      const bytes = objects.get(oidToHex(oid)) as Uint8Array;
      return bytes.length > maxBytes ? undefined : bytes;
    },
  };
  return { blob, tree, rawTree, source };
}

describe("mergeTrees", () => {
  it("takes one side's change of a file, merges both sides' changes line by line, and writes new objects", async () => {
    const s = store();
    const base = s.tree({ f: { oid: s.blob("a\nb\nc\n") }, g: { oid: s.blob("g\n") } });
    const ours = s.tree({ f: { oid: s.blob("A\nb\nc\n") }, g: { oid: s.blob("g\n") } });
    const theirs = s.tree({ f: { oid: s.blob("a\nb\nC\n") }, g: { oid: s.blob("G\n") } });
    const merged = await mergeTrees(s.source, base, ours, theirs);
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(merged.conflicts));
    expect(merged.objects.map((o) => o.type).sort()).toEqual(["blob", "tree"]);
    const blob = merged.objects.find((o) => o.type === "blob");
    expect(dec.decode(blob?.bytes)).toBe("A\nb\nC\n");
  });

  it("names each kind of conflict at its path", async () => {
    const s = store();
    const f = (t: string) => ({ oid: s.blob(t) });
    const base = s.tree({
      c: f("1\n"),
      m: f("m\n"),
      x: { mode: 0o100644, oid: s.blob("x\n") },
      l: { mode: 0o120000, oid: s.blob("t") },
    });
    const ours = s.tree({
      a: f("ours\n"),
      c: f("2\n"),
      m: f("changed\n"),
      x: { mode: 0o100755, oid: s.blob("x\n") },
      l: { mode: 0o120000, oid: s.blob("u") },
    });
    const theirs = s.tree({
      a: f("theirs\n"),
      c: f("3\n"),
      x: { mode: 0o100644, oid: s.blob("y\n") },
      l: { mode: 0o120000, oid: s.blob("v") },
    });
    const merged = await mergeTrees(s.source, base, ours, theirs);
    if (merged.kind !== "conflicts") return expect.fail("clean");
    expect(merged.conflicts.map((c) => [c.path, c.kind]).sort()).toEqual([
      ["a", "add_add"],
      ["c", "content"],
      ["l", "symlink"],
      ["m", "modify_delete"],
    ]);
  });

  it("takes contents given for files whose lines conflict, and no other conflict", async () => {
    const s = store();
    const f = (t: string) => ({ oid: s.blob(t) });
    const base = s.tree({ c: f("1\n"), m: f("m\n") });
    const ours = s.tree({ a: f("ours\n"), c: f("2\n"), m: f("changed\n") });
    const theirs = s.tree({ a: f("theirs\n"), c: f("3\n") });
    const asked: string[][] = [];
    const given: Record<string, string> = { a: "both\n", c: "", m: "kept\n" };
    const resolve = (file: {
      path: Uint8Array;
      base: Uint8Array;
      ours: Uint8Array;
      theirs: Uint8Array;
    }) => {
      const path = dec.decode(file.path);
      asked.push([path, dec.decode(file.base), dec.decode(file.ours), dec.decode(file.theirs)]);
      const content = given[path];
      return content === undefined ? undefined : enc.encode(content);
    };
    const partly = await mergeTrees(s.source, base, ours, theirs, { resolve });
    if (partly.kind !== "conflicts") return expect.fail("clean");
    expect(partly.conflicts.map((c) => [c.path, c.kind])).toEqual([["m", "modify_delete"]]);
    expect(asked.sort()).toEqual([
      ["a", "", "ours\n", "theirs\n"],
      ["c", "1\n", "2\n", "3\n"],
    ]);

    const without = s.tree({ a: f("ours\n"), c: f("2\n") });
    const merged = await mergeTrees(s.source, base, without, theirs, { resolve });
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(merged.conflicts));
    const blobs = merged.objects.filter((o) => o.type === "blob").map((o) => dec.decode(o.bytes));
    expect(blobs.sort()).toEqual(["", "both\n"]);
    // Declined: the conflict stays.
    const declined = await mergeTrees(s.source, base, without, theirs, {
      resolve: () => undefined,
    });
    expect(declined.kind).toBe("conflicts");
  });

  it("stops past its file merge budget", async () => {
    const s = store();
    const base = s.tree({ f: { oid: s.blob("a\nb\nc\n") } });
    const ours = s.tree({ f: { oid: s.blob("A\nb\nc\n") } });
    const theirs = s.tree({ f: { oid: s.blob("a\nb\nC\n") } });
    await expect(
      mergeTrees(s.source, base, ours, theirs, { budget: new MergeBudget(2_000, 0) }),
    ).rejects.toThrow(MergeLimitError);
  });
});

describe("mergeTrees, more cases", () => {
  const entries = async (
    s: ReturnType<typeof store>,
    tree: Oid,
    made: readonly { oid: Oid; bytes: Uint8Array; type: string }[],
  ) => {
    const found = made.find((o) => oidToHex(o.oid) === oidToHex(tree));
    const list = found
      ? (await import("../../src/object/tree.js")).parseTree(found.bytes).value
      : await s.source.readTree(tree);
    return list.map((e) => [dec.decode(e.name), e.mode.toString(8)]);
  };

  it("takes a deletion on one side, and the same change on both", async () => {
    const s = store();
    const base = s.tree({ a: { oid: s.blob("a\n") }, b: { oid: s.blob("b\n") } });
    const ours = s.tree({ b: { oid: s.blob("B\n") } });
    const theirs = s.tree({ a: { oid: s.blob("a\n") }, b: { oid: s.blob("B\n") } });
    const merged = await mergeTrees(s.source, base, ours, theirs);
    if (merged.kind !== "clean") return expect.fail("conflicts");
    expect(await entries(s, merged.tree, merged.objects)).toEqual([["b", "100644"]]);
  });

  it("resolves a mode changed on one side, and conflicts when both change it differently", async () => {
    const s = store();
    const x = s.blob("x\n");
    const t = (mode: number) => s.tree({ x: { mode, oid: x } });
    const one = await mergeTrees(s.source, t(0o100644), t(0o100755), t(0o100644));
    if (one.kind !== "clean") return expect.fail("conflicts");
    expect(await entries(s, one.tree, one.objects)).toEqual([["x", "100755"]]);
    // Content changed on one side, mode on the other: both kept.
    const y = s.tree({ x: { mode: 0o100644, oid: s.blob("y\n") } });
    const both = await mergeTrees(s.source, t(0o100644), t(0o100755), y);
    if (both.kind !== "clean") return expect.fail("conflicts");
    expect(await entries(s, both.tree, both.objects)).toEqual([["x", "100755"]]);
  });

  it("follows a deleted directory into the files the other side changed, and drops what empties", async () => {
    const s = store();
    const dir = (files: Record<string, string>) =>
      s.tree(Object.fromEntries(Object.entries(files).map(([n, t]) => [n, { oid: s.blob(t) }])));
    const base = s.tree({
      d: { mode: 0o40000, oid: dir({ x: "x\n", y: "y\n" }) },
      k: { oid: s.blob("k\n") },
    });
    const keepY = s.tree({
      d: { mode: 0o40000, oid: dir({ x: "x\n", y: "Y\n" }) },
      k: { oid: s.blob("k\n") },
    });
    const gone = s.tree({ k: { oid: s.blob("k\n") } });
    const conflict = await mergeTrees(s.source, base, keepY, gone);
    if (conflict.kind !== "conflicts") return expect.fail("clean");
    expect(conflict.conflicts.map((c) => [c.kind, c.path])).toEqual([["modify_delete", "d/y"]]);
    // Nothing changed inside: the directory goes with the deletion.
    const same = s.tree({
      d: { mode: 0o40000, oid: dir({ x: "x\n", y: "y\n" }) },
      k: { oid: s.blob("K\n") },
    });
    const clean = await mergeTrees(s.source, base, same, gone);
    if (clean.kind !== "clean") return expect.fail("conflicts");
    expect(await entries(s, clean.tree, clean.objects)).toEqual([["k", "100644"]]);
  });

  it("conflicts where a file and a directory of one name would both stay", async () => {
    const s = store();
    const base = s.tree({});
    const ours = s.tree({ x: { oid: s.blob("x\n") } });
    const theirs = s.tree({ x: { mode: 0o40000, oid: s.tree({ y: { oid: s.blob("y\n") } }) } });
    const merged = await mergeTrees(s.source, base, ours, theirs);
    if (merged.kind !== "conflicts") return expect.fail("clean");
    expect(merged.conflicts.map((c) => [c.kind, c.path])).toEqual([["file_directory", "x"]]);
  });

  it("calls a binary or too large file changed on both sides a conflict of its kind", async () => {
    const s = store();
    const one = (oid: Oid) => s.tree({ f: { oid } });
    const binary = await mergeTrees(
      s.source,
      one(s.blob("a")),
      one(s.blob("b\u0000")),
      one(s.blob("c")),
    );
    expect(binary.kind === "conflicts" ? binary.conflicts[0]?.kind : binary.kind).toBe("binary");
    const large = await mergeTrees(
      s.source,
      one(s.blob("aa")),
      one(s.blob("bb")),
      one(s.blob("cc")),
      {
        maxFileBytes: 1,
      },
    );
    expect(large.kind === "conflicts" ? large.conflicts[0]?.kind : large.kind).toBe("too_large");
  });

  it("stops past its tree budget, and makes the empty tree when nothing is left", async () => {
    const s = store();
    const base = s.tree({ f: { oid: s.blob("f\n") } });
    await expect(
      mergeTrees(s.source, base, s.tree({}), base, { budget: new MergeBudget(1) }),
    ).rejects.toThrow(MergeLimitError);
    const empty = await mergeTrees(s.source, base, s.tree({}), base);
    expect(empty.kind === "clean" ? oidToHex(empty.tree) : empty.kind).toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
  });
});

describe("mergeTrees, review regressions", () => {
  it("merges a line over 128 KiB without running out of stack", () => {
    const long = `${"x".repeat(200_000)}\n`;
    const merged = mergeFiles(
      enc.encode(`a\n${long}`),
      enc.encode(`A\n${long}`),
      enc.encode(`a\n${long}b\n`),
    );
    expect(merged.kind === "clean" ? dec.decode(merged.bytes) : merged.kind).toBe(`A\n${long}b\n`);
  });

  it("takes a mode changed on one side and content changed on the other, reading no blob", async () => {
    const s = store();
    const read = s.source.readBlob;
    let reads = 0;
    const source = {
      ...s.source,
      readBlob: async (oid: Oid, max: number) => {
        reads++;
        return read(oid, max);
      },
    };
    const bin = s.blob("old\u0000");
    const base = s.tree({ f: { mode: 0o100644, oid: bin } });
    const ours = s.tree({ f: { mode: 0o100755, oid: bin } });
    const theirs = s.tree({ f: { mode: 0o100644, oid: s.blob("new\u0000") } });
    const merged = await mergeTrees(source, base, ours, theirs);
    expect(merged.kind).toBe("clean");
    expect(reads).toBe(0);
  });

  it("reports a directory replaced by a file as a clash, beside the file changed inside", async () => {
    const s = store();
    const dir = (x: string) => s.tree({ x: { oid: s.blob(x) } });
    const base = s.tree({ d: { mode: 0o40000, oid: dir("x\n") } });
    const ours = s.tree({ d: { mode: 0o40000, oid: dir("X\n") } });
    const theirs = s.tree({ d: { oid: s.blob("a file\n") } });
    const merged = await mergeTrees(s.source, base, ours, theirs);
    if (merged.kind !== "conflicts") return expect.fail("clean");
    expect(merged.conflicts.map((c) => [c.kind, c.path]).sort()).toEqual([
      ["file_directory", "d"],
      ["modify_delete", "d/x"],
    ]);
  });

  it("reads a legacy file mode as git's index does: no throw writing it, no false mode conflict", async () => {
    const s = store();
    const legacy = s.blob("a\nb\nc\n");
    const base = s.tree({ f: { mode: 0o100664, oid: legacy }, g: { oid: s.blob("g\n") } });
    const ours = s.tree({
      f: { mode: 0o100664, oid: legacy },
      g: { oid: s.blob("g\n") },
      h: { oid: s.blob("h\n") },
    });
    const theirs = s.tree({ f: { mode: 0o100664, oid: legacy }, g: { oid: s.blob("G\n") } });
    expect((await mergeTrees(s.source, base, ours, theirs)).kind).toBe("clean");
    const exec = s.tree({ f: { mode: 0o100775, oid: legacy } });
    const edited = s.tree({ f: { mode: 0o100644, oid: s.blob("a\nb\nC\n") } });
    const merged = await mergeTrees(
      s.source,
      s.tree({ f: { mode: 0o100664, oid: legacy } }),
      exec,
      edited,
    );
    if (merged.kind !== "clean") return expect.fail(merged.conflicts[0]?.kind);
  });

  it("keeps content made twice once, and stops past its output budget", async () => {
    const s = store();
    const files = (t: string) =>
      s.tree({ a: { oid: s.blob(`1\n2\n${t}`) }, b: { oid: s.blob(`1\n2\n${t}`) } });
    const base = files("3\n");
    const ours = s.tree({ a: { oid: s.blob("X\n2\n3\n") }, b: { oid: s.blob("X\n2\n3\n") } });
    const theirs = s.tree({ a: { oid: s.blob("1\n2\nY\n") }, b: { oid: s.blob("1\n2\nY\n") } });
    const merged = await mergeTrees(s.source, base, ours, theirs);
    if (merged.kind !== "clean") return expect.fail("conflicts");
    expect(merged.objects.filter((o) => o.type === "blob")).toHaveLength(1);
    await expect(
      mergeTrees(s.source, base, ours, theirs, { budget: new MergeBudget(2_000, 1_000, 4) }),
    ).rejects.toThrow(MergeLimitError);
  });
});

describe("baseTreeOf", () => {
  it("is the merge base's tree for one, none for none, and manual when the bases conflict", async () => {
    const s = store();
    const [b1, b2] = [s.tree({ f: { oid: s.blob("x\n") } }), s.tree({ f: { oid: s.blob("y\n") } })];
    const trees = new Map([
      [oidToHex(b1), b1],
      [oidToHex(b2), b2],
    ]);
    const history = {
      mergeBases: async () => [],
      treeOf: async (c: Oid) => trees.get(oidToHex(c)) as Oid,
    };
    expect(await baseTreeOf(s.source, history, [])).toEqual({
      kind: "tree",
      tree: null,
      objects: [],
    });
    expect((await baseTreeOf(s.source, history, [b1])).kind).toBe("tree");
    // Two bases adding f differently from nothing: no base to merge from.
    expect(await baseTreeOf(s.source, history, [b1, b2])).toEqual({ kind: "manual" });
  });

  it("merges two or three bases into one, from their own merge bases, within its depth", async () => {
    const s = store();
    const t = (f: string, g: string) => s.tree({ f: { oid: s.blob(f) }, g: { oid: s.blob(g) } });
    const root = t("f\n", "g\n");
    const left = t("F\n", "g\n");
    const right = t("f\n", "G\n");
    const third = t("f\n", "g\n");
    const trees = new Map([root, left, right, third].map((x) => [oidToHex(x), x]));
    const history = {
      mergeBases: async () => [root],
      treeOf: async (c: Oid) => trees.get(oidToHex(c)) as Oid,
    };
    const two = await baseTreeOf(s.source, history, [left, right]);
    if (two.kind !== "tree" || !two.tree) return expect.fail("no tree");
    const made = two.objects.find((o) => oidToHex(o.oid) === oidToHex(two.tree as Oid));
    expect(made?.type).toBe("tree");
    const three = await baseTreeOf(s.source, history, [left, right, third]);
    expect(three.kind).toBe("tree");
    expect(await baseTreeOf(s.source, history, [left, right], {}, 8)).toEqual({ kind: "manual" });
    // Every step spends one budget: five bases cannot each read a fresh allowance.
    await expect(
      baseTreeOf(s.source, history, [left, right, third, left, right], {
        budget: new MergeBudget(4),
      }),
    ).rejects.toThrow(MergeLimitError);
  });
});

/** A tree's entries as [name, mode in octal, id in hex], from the merge's new objects or the store. */
async function listed(s: ReturnType<typeof store>, tree: Oid, made: readonly NewObject[]) {
  const found = made.find((o) => oidToHex(o.oid) === oidToHex(tree));
  const list = found ? parseTree(found.bytes).value : await s.source.readTree(tree);
  return list.map((e) => [dec.decode(e.name), e.mode.toString(8), oidToHex(e.oid)]);
}

const kinds = (merged: TreeMerge) =>
  merged.kind === "conflicts" ? merged.conflicts.map((c) => [c.path, c.kind]) : merged.kind;

/** The error a merge stopped with. */
const stopped = (merge: Promise<unknown>) =>
  merge.then(
    () => expect.fail("the merge finished"),
    (error: unknown) => {
      expect(error).toBeInstanceOf(MergeLimitError);
      const { name, limit, message } = error as MergeLimitError;
      return { name, limit, message };
    },
  );

describe("mergeTrees, kinds of entry", () => {
  const submodule = (hex: string) => ({ mode: 0o160000, oid: oidFromHex(hex.repeat(20)) });

  it("conflicts on a submodule both sides moved differently, and on a submodule one side made a file", async () => {
    const s = store();
    const base = s.tree({ s: submodule("11") });
    const theirs = s.tree({ s: submodule("33") });
    const moved = await mergeTrees(s.source, base, s.tree({ s: submodule("22") }), theirs);
    expect(kinds(moved)).toEqual([["s", "submodule"]]);
    const replaced = s.tree({ s: { oid: s.blob("a file\n") } });
    expect(kinds(await mergeTrees(s.source, base, replaced, theirs))).toEqual([["s", "submodule"]]);
  });

  it("conflicts on a file one side made a symlink and the other edited, whichever side did which", async () => {
    const s = store();
    const base = s.tree({ f: { oid: s.blob("a\nb\nc\n") } });
    const link = s.tree({ f: { mode: 0o120000, oid: s.blob("target") } });
    const edited = s.tree({ f: { oid: s.blob("a\nb\nC\n") } });
    expect(kinds(await mergeTrees(s.source, base, link, edited))).toEqual([["f", "symlink"]]);
    expect(kinds(await mergeTrees(s.source, base, edited, link))).toEqual([["f", "symlink"]]);
  });

  it("merges no lines from a symlink both sides replaced with different files: its target is no base", async () => {
    const s = store();
    // The link's target, read as lines, would merge both edits cleanly; git conflicts.
    const base = s.tree({ f: { mode: 0o120000, oid: s.blob("a\nb\nc\n") } });
    const ours = s.tree({ f: { oid: s.blob("A\nb\nc\n") } });
    const theirs = s.tree({ f: { oid: s.blob("a\nb\nC\n") } });
    const bases: string[] = [];
    const merged = await mergeTrees(s.source, base, ours, theirs, {
      resolve: (file) => {
        bases.push(dec.decode(file.base));
        return undefined;
      },
    });
    expect(kinds(merged)).toEqual([["f", "add_add"]]);
    expect(bases).toEqual([""]);
  });
});

describe("mergeTrees, modes", () => {
  /** A source that counts the blobs read through it. */
  const counting = (s: ReturnType<typeof store>) => {
    const counter = { reads: 0 };
    const source = {
      ...s.source,
      readBlob: (oid: Oid, max: number) => {
        counter.reads++;
        return s.source.readBlob(oid, max);
      },
    };
    return { counter, source };
  };

  it("takes a mode their side changed with the content our side changed, merging no lines", async () => {
    const s = store();
    const [old, edited] = [s.blob("a\nb\nc\n"), s.blob("A\nb\nc\n")];
    const { counter, source } = counting(s);
    const merged = await mergeTrees(
      source,
      s.tree({ f: { oid: old } }),
      s.tree({ f: { oid: edited } }),
      s.tree({ f: { mode: 0o100755, oid: old } }),
    );
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(kinds(merged)));
    expect(await listed(s, merged.tree, merged.objects)).toEqual([
      ["f", "100755", oidToHex(edited)],
    ]);
    expect(merged.objects.map((o) => o.type)).toEqual(["tree"]);
    expect(counter.reads).toBe(0);
  });

  it("takes the same content change from both sides with the mode one side changed, merging no lines", async () => {
    const s = store();
    const [old, edited] = [s.blob("a\nb\nc\n"), s.blob("A\nb\nc\n")];
    const { counter, source } = counting(s);
    const merged = await mergeTrees(
      source,
      s.tree({ f: { oid: old } }),
      s.tree({ f: { mode: 0o100755, oid: edited } }),
      s.tree({ f: { oid: edited } }),
    );
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(kinds(merged)));
    expect(await listed(s, merged.tree, merged.objects)).toEqual([
      ["f", "100755", oidToHex(edited)],
    ]);
    expect(merged.objects.map((o) => o.type)).toEqual(["tree"]);
    expect(counter.reads).toBe(0);
  });

  it("conflicts on a file both sides added with different modes, with or without the same content", async () => {
    const s = store();
    const empty = s.tree({});
    const plain = s.tree({ x: { oid: s.blob("A\nb\nc\n") } });
    for (const content of ["a\nb\nC\n", "A\nb\nc\n"]) {
      const exec = s.tree({ x: { mode: 0o100755, oid: s.blob(content) } });
      expect(kinds(await mergeTrees(s.source, empty, plain, exec))).toEqual([["x", "mode"]]);
    }
  });
});

describe("mergeTrees, directories", () => {
  it("merges a directory both sides changed inside, file by file", async () => {
    const s = store();
    const dir = (x: string, y: string) => s.tree({ x: { oid: s.blob(x) }, y: { oid: s.blob(y) } });
    const at = (d: Oid) => s.tree({ d: { mode: 0o40000, oid: d } });
    const merged = await mergeTrees(
      s.source,
      at(dir("x\n", "y\n")),
      at(dir("X\n", "y\n")),
      at(dir("x\n", "Y\n")),
    );
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(kinds(merged)));
    const [root] = await listed(s, merged.tree, merged.objects);
    expect(root?.slice(0, 2)).toEqual(["d", "40000"]);
    expect(await listed(s, oidFromHex(root?.[2] as string), merged.objects)).toEqual([
      ["x", "100644", oidToHex(s.blob("X\n"))],
      ["y", "100644", oidToHex(s.blob("Y\n"))],
    ]);
  });

  it("writes again a directory both sides changed alike, with git's modes, and nothing under it that did not change", async () => {
    const s = store();
    const [f, sub] = [s.blob("f\n"), s.tree({ h: { oid: s.blob("h\n") } })];
    const dir = (g: string) =>
      s.tree({
        f: { mode: 0o100664, oid: f },
        g: { oid: s.blob(g) },
        sub: { mode: 0o40000, oid: sub },
      });
    const changed = dir("G\n");
    const merged = await mergeTrees(
      s.source,
      s.tree({ d: { mode: 0o40000, oid: dir("g\n") } }),
      s.tree({ d: { mode: 0o40000, oid: changed }, x: { oid: s.blob("x\n") } }),
      s.tree({ d: { mode: 0o40000, oid: changed }, y: { oid: s.blob("y\n") } }),
    );
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(kinds(merged)));
    const [d] = await listed(s, merged.tree, merged.objects);
    expect(await listed(s, oidFromHex(d?.[2] as string), merged.objects)).toEqual([
      ["f", "100644", oidToHex(f)],
      ["g", "100644", oidToHex(s.blob("G\n"))],
      ["sub", "40000", oidToHex(sub)],
    ]);
    // The directory and the root, nothing more.
    expect(merged.objects.map((o) => o.type)).toEqual(["tree", "tree"]);
  });

  it("writes a directory both sides added alike with git's modes", async () => {
    const s = store();
    const f = s.blob("f\n");
    const dir = s.tree({ f: { mode: 0o100664, oid: f } });
    const merged = await mergeTrees(
      s.source,
      s.tree({}),
      s.tree({ d: { mode: 0o40000, oid: dir } }),
      s.tree({ d: { mode: 0o40000, oid: dir } }),
    );
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(kinds(merged)));
    const [d] = await listed(s, merged.tree, merged.objects);
    expect(await listed(s, oidFromHex(d?.[2] as string), merged.objects)).toEqual([
      ["f", "100644", oidToHex(f)],
    ]);
  });

  it("takes a directory one side put in place of a file the other side left alone", async () => {
    const s = store();
    const file = s.tree({ d: { oid: s.blob("a\nb\nc\n") } });
    const dir = s.tree({ f: { oid: s.blob("h\n") } });
    const merged = await mergeTrees(
      s.source,
      file,
      s.tree({ d: { mode: 0o40000, oid: dir } }),
      file,
    );
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(kinds(merged)));
    expect(await listed(s, merged.tree, merged.objects)).toEqual([["d", "40000", oidToHex(dir)]]);
  });

  it("gives the three sides of a file and a directory left with one name, whichever side has which", async () => {
    const s = store();
    const [x, edited, file] = [s.blob("x\n"), s.blob("X\n"), s.blob("a file\n")];
    const [baseDir, changedDir] = [s.tree({ x: { oid: x } }), s.tree({ x: { oid: edited } })];
    const base = s.tree({ d: { mode: 0o40000, oid: baseDir } });
    const changed = s.tree({ d: { mode: 0o40000, oid: changedDir } });
    const replaced = s.tree({ d: { oid: file } });
    const conflict = (
      kind: string,
      path: string,
      sides: readonly (readonly [number, Oid] | null)[],
    ) => {
      const [b, o, t] = sides.map((e) => (e ? { mode: e[0], oid: e[1] } : null));
      return { kind, path, pathBytes: enc.encode(path), base: b, ours: o, theirs: t };
    };
    const byPath = (merged: TreeMerge) =>
      merged.kind === "conflicts"
        ? [...merged.conflicts].sort((a, b) => (a.path < b.path ? -1 : 1))
        : merged.kind;

    expect(byPath(await mergeTrees(s.source, base, changed, replaced))).toEqual([
      conflict("file_directory", "d", [
        [0o40000, baseDir],
        [0o40000, changedDir],
        [0o100644, file],
      ]),
      conflict("modify_delete", "d/x", [[0o100644, x], [0o100644, edited], null]),
    ]);
    expect(byPath(await mergeTrees(s.source, base, replaced, changed))).toEqual([
      conflict("file_directory", "d", [
        [0o40000, baseDir],
        [0o100644, file],
        [0o40000, changedDir],
      ]),
      conflict("modify_delete", "d/x", [[0o100644, x], null, [0o100644, edited]]),
    ]);
  });

  it("gives a conflict's path as bytes and as text: a name not UTF-8 gets replacement characters, a leading BOM stays", async () => {
    const s = store();
    const empty = s.tree({});
    for (const [bytes, text] of [
      [[0x66, 0xff], "f�"],
      [[0xef, 0xbb, 0xbf, 0x66], "﻿f"],
    ] as const) {
      const name = new Uint8Array(bytes);
      const side = (content: string) => s.rawTree([{ name, mode: 0o100644, oid: s.blob(content) }]);
      const merged = await mergeTrees(s.source, empty, side("ours\n"), side("theirs\n"));
      if (merged.kind !== "conflicts") return expect.fail("clean");
      expect(merged.conflicts.map((c) => [c.pathBytes, c.path])).toEqual([[name, text]]);
    }
  });
});

describe("mergeTrees, files it cannot merge line by line", () => {
  it("conflicts as too large when any one side is over the size bound", async () => {
    const s = store();
    const one = (text: string) => s.tree({ f: { oid: s.blob(text) } });
    for (const [base, ours, theirs] of [
      ["aaaa", "b", "c"],
      ["a", "bbbb", "c"],
      ["a", "b", "cccc"],
    ] as const) {
      const merged = await mergeTrees(s.source, one(base), one(ours), one(theirs), {
        maxFileBytes: 2,
      });
      expect(kinds(merged)).toEqual([["f", "too_large"]]);
    }
  });

  it("asks for contents only where lines conflict: never for a binary file or one with too many lines", async () => {
    const s = store();
    const one = (text: string) => s.tree({ f: { oid: s.blob(text) } });
    const asked: string[] = [];
    const resolve = (file: { path: Uint8Array }) => {
      asked.push(dec.decode(file.path));
      return enc.encode("resolved\n");
    };
    const binary = await mergeTrees(s.source, one("a"), one("b\u0000"), one("c"), { resolve });
    expect(kinds(binary)).toEqual([["f", "binary"]]);
    // Within the size bound, past the line budget of a line merge.
    const lines = (first: string) => `${first}\n${"\n".repeat(100_000)}`;
    const long = await mergeTrees(s.source, one(lines("a")), one(lines("b")), one(lines("c")), {
      resolve,
    });
    expect(kinds(long)).toEqual([["f", "too_large"]]);
    expect(asked).toEqual([]);
  });
});

describe("mergeTrees, budget", () => {
  const files = (s: ReturnType<typeof store>, a: string, b: string) =>
    s.tree({ a: { oid: s.blob(a) }, b: { oid: s.blob(b) } });

  it("reads exactly as many trees as its budget allows, and stops past it naming the limit", async () => {
    const s = store();
    const [base, ours, theirs] = [
      files(s, "a\n", "b\n"),
      files(s, "A\n", "b\n"),
      files(s, "a\n", "B\n"),
    ];
    // Three trees: the base and the two sides.
    const exact = await mergeTrees(s.source, base, ours, theirs, { budget: new MergeBudget(3) });
    expect(exact.kind).toBe("clean");
    expect(
      await stopped(mergeTrees(s.source, base, ours, theirs, { budget: new MergeBudget(2) })),
    ).toEqual({
      name: "MergeLimitError",
      limit: "trees",
      message: "the merge needs more trees than it may use",
    });
  });

  it("merges exactly as many files line by line as its budget allows, and stops past it naming the limit", async () => {
    const s = store();
    const [base, ours, theirs] = [
      files(s, "1\n2\n3\n", "b\n"),
      files(s, "X\n2\n3\n", "b\n"),
      files(s, "1\n2\nY\n", "b\n"),
    ];
    const exact = await mergeTrees(s.source, base, ours, theirs, {
      budget: new MergeBudget(2_000, 1),
    });
    expect(exact.kind).toBe("clean");
    expect(
      await stopped(
        mergeTrees(s.source, base, ours, theirs, { budget: new MergeBudget(2_000, 0) }),
      ),
    ).toEqual({
      name: "MergeLimitError",
      limit: "files",
      message: "the merge needs more files than it may use",
    });
  });

  it("spends its output budget once per new object, content made twice counting once", async () => {
    const s = store();
    const base = files(s, "1\n2\n3\n", "1\n2\n3\n");
    const ours = files(s, "X\n2\n3\n", "X\n2\n3\n");
    const theirs = files(s, "1\n2\nY\n", "1\n2\nY\n");
    const merged = await mergeTrees(s.source, base, ours, theirs);
    if (merged.kind !== "clean") return expect.fail(JSON.stringify(kinds(merged)));
    // One blob of 6 bytes and a tree of two 29-byte entries.
    expect(merged.objects.reduce((n, o) => n + o.bytes.length, 0)).toBe(64);
    const exact = await mergeTrees(s.source, base, ours, theirs, {
      budget: new MergeBudget(2_000, 1_000, 64),
    });
    expect(exact.kind).toBe("clean");
    expect(
      await stopped(
        mergeTrees(s.source, base, ours, theirs, { budget: new MergeBudget(2_000, 1_000, 63) }),
      ),
    ).toEqual({
      name: "MergeLimitError",
      limit: "output",
      message: "the merge needs more output than it may use",
    });
  });
});

describe("baseTreeOf, steps and bounds", () => {
  it("is the one merge base's tree at any depth", async () => {
    const s = store();
    const only = s.tree({ f: { oid: s.blob("f\n") } });
    const history = { mergeBases: async () => [], treeOf: async (c: Oid) => c };
    expect(await baseTreeOf(s.source, history, [only], {}, MAX_VIRTUAL_DEPTH)).toEqual({
      kind: "tree",
      tree: only,
      objects: [],
    });
  });

  it("merges each base from its merge bases against those merged so far, reading files earlier steps made within the size bound", async () => {
    const s = store();
    const one = (text: string) => s.tree({ f: { oid: s.blob(text) } });
    const root = one("1\n2\n3\n4\n5\n");
    const left = one("0\n1\n2\n3\n4\n5\n");
    const right = one("1\n2\n3\n4\n5\n6\n");
    const third = one("1\n2\nX\n4\n5\n");
    const asked: string[][] = [];
    const history = {
      mergeBases: async (next: Oid, merged: readonly Oid[]) => {
        asked.push([next, ...merged].map(oidToHex));
        return [root];
      },
      treeOf: async (c: Oid) => c,
    };
    // The first step makes a 14-byte file; the second merges it with the third base's.
    const base = await baseTreeOf(s.source, history, [left, right, third], { maxFileBytes: 14 });
    if (base.kind !== "tree" || !base.tree) return expect.fail(base.kind);
    const made = new Map(base.objects.map((o) => [oidToHex(o.oid), o]));
    const [f] = await listed(s, base.tree, base.objects);
    expect(dec.decode(made.get(f?.[2] as string)?.bytes)).toBe("0\n1\n2\nX\n4\n5\n6\n");
    expect(asked).toEqual([[right, left].map(oidToHex), [third, left, right].map(oidToHex)]);
    // The file the first step made is over a smaller bound: the second step cannot merge it.
    expect(await baseTreeOf(s.source, history, [left, right, third], { maxFileBytes: 13 })).toEqual(
      { kind: "manual" },
    );
  });

  it("merges from a virtual base of its own, and keeps the objects that base is made of", async () => {
    const s = store();
    const t = (files: Record<string, string>) =>
      s.tree(Object.fromEntries(Object.entries(files).map(([n, c]) => [n, { oid: s.blob(c) }])));
    const root = t({ f: "f\n", g: "g\n" });
    const p = t({ f: "F\n", g: "g\n" });
    const q = t({ f: "f\n", g: "G\n" });
    const left = t({ f: "F\n", g: "G\n", h: "h\n" });
    const right = t({ f: "F\n", g: "G\n", k: "k\n" });
    // Left and right have two merge bases, p and q, which have one.
    const bases = new Map([
      [oidToHex(right), [p, q]],
      [oidToHex(q), [root]],
    ]);
    const history = {
      mergeBases: async (next: Oid) => bases.get(oidToHex(next)) ?? [],
      treeOf: async (c: Oid) => c,
    };
    const base = await baseTreeOf(s.source, history, [left, right]);
    if (base.kind !== "tree" || !base.tree) return expect.fail(base.kind);
    const blob = (text: string) => oidToHex(s.blob(text));
    expect(await listed(s, base.tree, base.objects)).toEqual([
      ["f", "100644", blob("F\n")],
      ["g", "100644", blob("G\n")],
      ["h", "100644", blob("h\n")],
      ["k", "100644", blob("k\n")],
    ]);
    // The virtual base of p and q, then the merge from it.
    const [virtual] = base.objects;
    expect(base.objects.map((o) => o.type)).toEqual(["tree", "tree"]);
    expect(await listed(s, virtual?.oid as Oid, base.objects)).toEqual([
      ["f", "100644", blob("F\n")],
      ["g", "100644", blob("G\n")],
    ]);
  });

  it("needs a person once merge bases recur past the depth bound", async () => {
    const s = store();
    const [x, y] = [s.tree({ f: { oid: s.blob("x\n") } }), s.tree({ f: { oid: s.blob("y\n") } })];
    let asked = 0;
    const history = {
      // Every pair has the same two merge bases again.
      mergeBases: async () => {
        if (++asked > 100) throw new Error("no depth bound");
        return [x, y];
      },
      treeOf: async (c: Oid) => c,
    };
    expect(await baseTreeOf(s.source, history, [x, y])).toEqual({ kind: "manual" });
    expect(asked).toBe(MAX_VIRTUAL_DEPTH);
  });
});
