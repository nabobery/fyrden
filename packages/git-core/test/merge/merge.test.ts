import { describe, expect, it } from "vitest";
import { merge3 } from "../../src/merge/diff3.js";
import { mergeFiles, withConflictMarkers } from "../../src/merge/file-merge.js";
import { MergeBudget, MergeLimitError, mergeTrees } from "../../src/merge/merge-trees.js";
import { baseTreeOf } from "../../src/merge/virtual-base.js";
import { type Oid, oidToHex } from "../../src/object/oid.js";
import type { TreeEntry } from "../../src/object/tree.js";

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
  const source = {
    readTree: async (oid: Oid) => objects.get(oidToHex(oid)) as TreeEntry[],
    readBlob: async (oid: Oid, maxBytes: number) => {
      const bytes = objects.get(oidToHex(oid)) as Uint8Array;
      return bytes.length > maxBytes ? undefined : bytes;
    },
  };
  return { blob, tree, source };
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
