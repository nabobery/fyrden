import { describe, expect, it } from "vitest";
import { findExactRenames } from "../../src/diff/rename.js";
import { diffTrees, TreeDiffLimitError } from "../../src/diff/tree-diff.js";
import type { Oid } from "../../src/object/oid.js";
import type { TreeEntry } from "../../src/object/tree.js";

const enc = new TextEncoder();
const oid = (n: number) => new Uint8Array(20).fill(n) as Oid;
const FILE = 0o100644;
const TREE = 0o40000;
const entry = (name: string, mode: number, id: number): TreeEntry => ({
  name: enc.encode(name),
  mode,
  oid: oid(id),
});

/** Trees by id, for a reader that counts its reads. */
function store(trees: Record<number, TreeEntry[]>) {
  const reads: number[] = [];
  return {
    reads,
    read: async (o: Oid) => {
      reads.push(o[0] as number);
      return trees[o[0] as number] ?? [];
    },
  };
}

describe("diffTrees", () => {
  it("skips a subtree with the same id without reading it", async () => {
    const s = store({
      1: [entry("same", TREE, 10), entry("x", FILE, 20)],
      2: [entry("same", TREE, 10), entry("x", FILE, 21)],
    });
    const { changes } = await diffTrees(s.read, oid(1), oid(2));
    expect(changes.map((c) => [c.status, c.path])).toEqual([["modified", "x"]]);
    expect(s.reads).toEqual([1, 2]);
  });

  it("stops at a path longer than its budget, without copying the path at every level", async () => {
    const deep: Record<number, TreeEntry[]> = {};
    for (let level = 1; level <= 50; level++)
      deep[level] = [entry("d".repeat(100), TREE, level + 1)];
    deep[51] = [entry("f", FILE, 99)];
    const s = store(deep);
    await expect(diffTrees(s.read, null, oid(1), { maxPathBytes: 4_096 })).rejects.toThrow(
      TreeDiffLimitError,
    );
    const shallow = await diffTrees(s.read, null, oid(1), { maxPathBytes: 6_000, maxTrees: 100 });
    expect(shallow.changes[0]?.path.length).toBe(50 * 101 + 1);
  });

  it("keeps a leading byte order mark in a path: two names that differ by one stay apart", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("name")]);
    const s = store({ 2: [entry("name", FILE, 6), { name: bom, mode: FILE, oid: oid(5) }] });
    const { changes } = await diffTrees(s.read, null, oid(2));
    expect(changes.map((c) => c.path)).toEqual(["name", "\ufeffname"]);
  });

  it("stops past its tree budget", async () => {
    const s = store({ 1: [entry("d", TREE, 3)], 2: [entry("d", TREE, 4)], 3: [], 4: [] });
    await expect(diffTrees(s.read, oid(1), oid(2), { maxTrees: 3 })).rejects.toThrow(
      TreeDiffLimitError,
    );
  });

  it("lists a whole side as added or removed, and resumes after a path", async () => {
    const s = store({ 2: [entry("a", FILE, 5), entry("d", TREE, 3)], 3: [entry("b", FILE, 6)] });
    const all = await diffTrees(s.read, null, oid(2));
    expect(all.changes.map((c) => [c.status, c.path])).toEqual([
      ["added", "a"],
      ["added", "d/b"],
    ]);
    const rest = await diffTrees(s.read, null, oid(2), { after: enc.encode("a") });
    expect(rest.changes.map((c) => c.path)).toEqual(["d/b"]);
  });
});

describe("findExactRenames", () => {
  it("compares last path components as bytes, not as decoded text", async () => {
    const bytes = (...b: number[]) => new Uint8Array(b);
    const s = store({
      1: [
        { name: bytes(0x61, 0x2f, 0xfe), mode: FILE, oid: oid(7) },
        { name: bytes(0x62, 0x2f, 0xff), mode: FILE, oid: oid(7) },
      ],
      2: [{ name: bytes(0x63, 0x2f, 0xff), mode: FILE, oid: oid(7) }],
    });
    const { changes } = await diffTrees(s.read, oid(1), oid(2));
    const renamed = findExactRenames(changes).find((e) => e.status === "renamed");
    expect(
      renamed && "previousPathBytes" in renamed ? [...renamed.previousPathBytes] : null,
    ).toEqual([0x62, 0x2f, 0xff]);
  });

  it("pairs many identical files one by one", async () => {
    const n = 5_000;
    const removed = Array.from({ length: n }, (_, i) =>
      entry(`old${String(i).padStart(5, "0")}`, FILE, 7),
    );
    const added = Array.from({ length: n }, (_, i) =>
      entry(`new${String(i).padStart(5, "0")}`, FILE, 7),
    );
    const s = store({ 1: removed, 2: added });
    const { changes } = await diffTrees(s.read, oid(1), oid(2));
    const entries = findExactRenames(changes);
    expect(entries.every((e) => e.status === "renamed")).toBe(true);
    expect(entries).toHaveLength(n);
  });

  it("pairs a removed file with an added one of the same content, preferring the same name", async () => {
    const s = store({
      1: [entry("a/f", FILE, 7), entry("g", FILE, 7), entry("k", FILE, 8)],
      2: [entry("b/f", FILE, 7), entry("k", 0o120000, 8)],
    });
    const { changes } = await diffTrees(s.read, oid(1), oid(2));
    const entries = findExactRenames(changes);
    expect(
      entries.map((e) => [e.status, e.path, "previousPath" in e ? e.previousPath : null]),
    ).toEqual([
      ["renamed", "b/f", "a/f"],
      ["removed", "g", null],
      ["type_changed", "k", null],
    ]);
  });
});
