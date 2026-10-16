import { describe, expect, it } from "vitest";
import { MergeBudget, mergeTrees } from "../../src/merge/merge-trees.js";
import type { Oid } from "../../src/object/oid.js";
import { kinds, stopped, store } from "./support.js";

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

  /** Sides that each change `file` (its path's directories by name) differently, as a symlink: a conflict without a file merge. */
  const deep = (s: ReturnType<typeof store>, dirs: readonly string[], file: string) => {
    const side = (target: string) =>
      dirs.reduceRight(
        (inner, dir) => s.tree({ [dir]: { mode: 0o40000, oid: inner } }),
        s.tree({ [file]: { mode: 0o120000, oid: s.blob(target) } }),
      );
    return [side("base"), side("ours"), side("theirs")] as const;
  };

  it("follows a path of exactly 4,096 bytes, and stops at a longer one naming the limit", async () => {
    const s = store();
    // Fifteen 255-byte directories with their slashes: 3,840 bytes.
    const dirs = Array.from({ length: 15 }, (_, i) => String(i % 10).repeat(255));
    const exact = await mergeTrees(s.source, ...deep(s, dirs, "f".repeat(256)));
    if (exact.kind !== "conflicts") return expect.fail("clean");
    expect(exact.conflicts.map((c) => [c.pathBytes.length, c.kind])).toEqual([[4_096, "symlink"]]);
    expect(await stopped(mergeTrees(s.source, ...deep(s, dirs, "f".repeat(257))))).toEqual({
      name: "MergeLimitError",
      limit: "path",
      message: "a path is longer than the merge may follow",
    });
  });

  it("walks into no directory whose path and slash are past the limit", async () => {
    const s = store();
    const dirs = Array.from({ length: 15 }, (_, i) => String(i % 10).repeat(255));
    // A last directory of 254 bytes and its slash: 4,095 bytes, and a one-byte name fits.
    const fits = await mergeTrees(s.source, ...deep(s, [...dirs, "x".repeat(254)], "f"));
    expect(kinds(fits)).toEqual([[`${[...dirs, "x".repeat(254)].join("/")}/f`, "symlink"]]);
    const reads = (last: number) => {
      const counted = { trees: 0 };
      const source = {
        ...s.source,
        readTree: (oid: Oid) => {
          counted.trees++;
          return s.source.readTree(oid);
        },
      };
      const merge = mergeTrees(source, ...deep(s, [...dirs, "x".repeat(last)], "f"));
      return stopped(merge).then((error) => ({ limit: error.limit, trees: counted.trees }));
    };
    // 4,096 bytes with its slash: walked into, and the name under it is one too many.
    expect(await reads(255)).toEqual({ limit: "path", trees: 3 * 17 });
    // 4,097: not read at all (the roots and fifteen directories on three sides).
    expect(await reads(256)).toEqual({ limit: "path", trees: 3 * 16 });
  });

  /** Sides that change each of `names` differently, as a symlink: conflicts without file merges. */
  const links = (s: ReturnType<typeof store>, names: readonly string[]) => {
    const side = (target: string) =>
      s.tree(
        Object.fromEntries(
          names.map((n) => [n, { mode: 0o120000, oid: s.blob(`${target}-${n}`) }]),
        ),
      );
    return [side("base"), side("ours"), side("theirs")] as const;
  };

  it("reports exactly as many conflicts as its budget allows, and stops past it naming the limit", async () => {
    const s = store();
    const exact = await mergeTrees(s.source, ...links(s, ["a", "b"]), {
      budget: new MergeBudget(2_000, 1_000, 1024, 2),
    });
    expect(kinds(exact)).toEqual([
      ["a", "symlink"],
      ["b", "symlink"],
    ]);
    expect(
      await stopped(
        mergeTrees(s.source, ...links(s, ["a", "b", "c"]), {
          budget: new MergeBudget(2_000, 1_000, 1024, 2),
        }),
      ),
    ).toEqual({
      name: "MergeLimitError",
      limit: "conflicts",
      message: "the merge has more conflicts than it may report",
    });
  });

  it("reports conflicts with exactly as many path bytes as its budget allows, and stops past it", async () => {
    const s = store();
    const budget = () => new MergeBudget(2_000, 1_000, 1024, 1_000, 5);
    const exact = await mergeTrees(s.source, ...links(s, ["ab", "cd", "e"]), {
      budget: budget(),
    });
    expect(kinds(exact)).toEqual([
      ["ab", "symlink"],
      ["cd", "symlink"],
      ["e", "symlink"],
    ]);
    expect(
      await stopped(mergeTrees(s.source, ...links(s, ["ab", "cd", "ef"]), { budget: budget() })),
    ).toMatchObject({ limit: "conflicts" });
  });

  it("charges each conflict once whatever its kind, a file and a directory clash included", async () => {
    const s = store();
    const dir = s.tree({ y: { oid: s.blob("y\n") } });
    const base = s.tree({ m: { oid: s.blob("m\n") } });
    const ours = s.tree({ m: { oid: s.blob("M\n") }, x: { oid: s.blob("x\n") } });
    const theirs = s.tree({ x: { mode: 0o40000, oid: dir } });
    const budget = new MergeBudget();
    const merged = await mergeTrees(s.source, base, ours, theirs, { budget });
    expect(kinds(merged)).toEqual([
      ["m", "modify_delete"],
      ["x", "file_directory"],
    ]);
    expect([budget.conflicts, budget.conflictBytes]).toEqual([2, 2]);
  });
});
