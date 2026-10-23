import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type DiffCursor,
  diffTreesFrom,
  ReadDeferred,
  type ResumedDiff,
} from "../../src/diff/resumable-diff.js";
import { diffTrees, TreeDiffLimitError } from "../../src/diff/tree-diff.js";
import type { Oid } from "../../src/object/oid.js";
import { compareTreeEntries, type TreeEntry } from "../../src/object/tree.js";

const enc = new TextEncoder();
const FILE = 0o100644;
const EXEC = 0o100755;
const LINK = 0o120000;
const TREE = 0o40000;

/** A store of trees by id, built from nested descriptions, with a reader that counts. */
class Store {
  readonly trees = new Map<string, TreeEntry[]>();
  #next = 1;
  reads = 0;

  /** A tree's id: the same description gets the same id, as git's content addressing does. */
  tree(spec: Spec): Oid {
    const entries = Object.entries(spec)
      .map(([name, value]): TreeEntry => {
        if (!Array.isArray(value))
          return { name: enc.encode(name), mode: TREE, oid: this.tree(value as Spec) };
        const [mode, blob] = value as readonly [number, number];
        return { name: enc.encode(name), mode, oid: blobOid(blob) };
      })
      .sort(compareTreeEntries);
    const key = JSON.stringify(entries.map((e) => [[...e.name], e.mode, [...e.oid]]));
    for (const [id, tree] of this.trees)
      if (JSON.stringify(tree.map((e) => [[...e.name], e.mode, [...e.oid]])) === key)
        return idOid(id);
    const id = `t${this.#next++}`;
    this.trees.set(id, entries);
    return idOid(id);
  }

  read = async (oid: Oid): Promise<readonly TreeEntry[]> => {
    this.reads++;
    const tree = this.trees.get(new TextDecoder().decode(oid).replace(/\0+$/, ""));
    if (!tree) throw new Error("no such tree");
    return tree;
  };
}

type Spec = { [name: string]: Spec | readonly [number, number] };

const idOid = (id: string): Oid => {
  const bytes = new Uint8Array(20);
  bytes.set(enc.encode(id));
  return bytes as Oid;
};
const blobOid = (n: number): Oid => {
  const bytes = new Uint8Array(20).fill(0xff);
  bytes[0] = n;
  return bytes as Oid;
};

/** Runs a resumable diff to the end in slices, as the job would, returning every change listed. */
async function resumed(
  store: Store,
  oldTree: Oid | null,
  newTree: Oid | null,
  limits: { maxChanges: number; maxScanned: number },
  defer: (n: number) => boolean = () => false,
) {
  const paths: string[] = [];
  let from: DiffCursor | null = null;
  let reads = 0;
  let maxScanned = limits.maxScanned;
  for (let slices = 0; ; slices++) {
    if (slices > 10_000) throw new Error("no end");
    const result: ResumedDiff = await diffTreesFrom(
      async (oid) => {
        if (defer(reads++)) throw new ReadDeferred();
        return store.read(oid);
      },
      oldTree,
      newTree,
      from,
      { maxChanges: limits.maxChanges, maxScanned, maxDepth: 64 },
    );
    for (const change of result.changes) paths.push(`${change.status} ${change.path}`);
    if (result.next === null) return paths;
    // No progress (the ancestors alone used the budget): the job would end `stuck` after three;
    // here the next slice gets more, so every cut is tried.
    if (result.changes.length === 0 && JSON.stringify(result.next) === JSON.stringify(from))
      maxScanned *= 2;
    from = result.next;
  }
}

const oneShot = async (store: Store, oldTree: Oid | null, newTree: Oid | null) =>
  (await diffTrees(store.read, oldTree, newTree, { maxTrees: 100_000 })).changes.map(
    (c) => `${c.status} ${c.path}`,
  );

describe("diffTreesFrom", () => {
  it("lists what diffTrees lists, in the same order, in one slice", async () => {
    const s = new Store();
    const a = s.tree({ a: [FILE, 1], b: { c: [FILE, 2] }, same: { x: [FILE, 9] } });
    const b = s.tree({ a: [FILE, 3], b: { c: [FILE, 2], d: [EXEC, 4] }, same: { x: [FILE, 9] } });
    const result = await diffTreesFrom(s.read, a, b, null, {
      maxChanges: 100,
      maxScanned: 1_000,
      maxDepth: 64,
    });
    expect(result.next).toBeNull();
    expect(result.changes.map((c) => `${c.status} ${c.path}`)).toEqual(await oneShot(s, a, b));
  });

  it("resumes inside a directory without skipping what sorts after the cursor", async () => {
    const s = new Store();
    const a = s.tree({});
    // Names below "0" and above, a file and a directory sharing a name across the sides.
    const b = s.tree({
      a: { " ": [FILE, 1], "!": [FILE, 2], "-": [FILE, 3], "0": [FILE, 4], "0x": [FILE, 5] },
      "a-": [FILE, 6],
      "a.b": [FILE, 7],
      a0: [FILE, 8],
    });
    const all = await oneShot(s, a, b);
    for (let n = 1; n <= all.length; n++)
      expect(await resumed(s, a, b, { maxChanges: n, maxScanned: 1_000 })).toEqual(all);
  });

  it("keeps a file and a directory of the same name apart across the sides", async () => {
    const s = new Store();
    const a = s.tree({ a: [FILE, 1], "a-": [FILE, 2], b: { x: [FILE, 3] } });
    const b = s.tree({ a: { x: [FILE, 4] }, "a-": [FILE, 5], b: [LINK, 6] });
    const all = await oneShot(s, a, b);
    expect(all).toEqual(["removed a", "modified a-", "added a/x", "added b", "removed b/x"]);
    for (let n = 1; n <= all.length; n++)
      expect(await resumed(s, a, b, { maxChanges: n, maxScanned: 1_000 })).toEqual(all);
  });

  it("stops before reading a tree its reader defers, and resumes there", async () => {
    const s = new Store();
    const a = s.tree({ d: { e: { f: [FILE, 1] } } });
    const b = s.tree({ d: { e: { f: [FILE, 2], g: [FILE, 3] } } });
    let reads = 0;
    const first = await diffTreesFrom(
      async (oid) => {
        // The root pair and d's pair read; e's deferred.
        if (++reads > 4) throw new ReadDeferred();
        return s.read(oid);
      },
      a,
      b,
      null,
      { maxChanges: 100, maxScanned: 1_000, maxDepth: 64 },
    );
    expect(first.changes).toEqual([]);
    expect(first.stop).toBe("read");
    expect(first.next).not.toBeNull();
    const rest = await diffTreesFrom(s.read, a, b, first.next, {
      maxChanges: 100,
      maxScanned: 1_000,
      maxDepth: 64,
    });
    expect(rest.changes.map((c) => `${c.status} ${c.path}`)).toEqual([
      "modified d/e/f",
      "added d/e/g",
    ]);
    expect(rest.next).toBeNull();
  });

  it("stops before reading past its scan budget, counting every entry of every tree read", async () => {
    const s = new Store();
    const many: Spec = {};
    for (let i = 0; i < 50; i++) many[`f${String(i).padStart(2, "0")}`] = [FILE, i];
    const a = s.tree({ big: many, later: { x: [FILE, 1] } });
    const b = s.tree({ big: many, later: { x: [FILE, 2] } });
    const result = await diffTreesFrom(s.read, a, b, null, {
      maxChanges: 100,
      maxScanned: 4,
      maxDepth: 64,
    });
    // The root pair (4 entries) read; `later` not, though `big` is skipped unread (same id).
    expect(result.stop).toBe("scanned");
    expect(result.scanned).toBe(4);
    expect(result.changes).toEqual([]);
    const rest = await diffTreesFrom(s.read, a, b, result.next, {
      maxChanges: 100,
      maxScanned: 1_000,
      maxDepth: 64,
    });
    expect(rest.changes.map((c) => c.path)).toEqual(["later/x"]);
  });

  it("answers the cursor it started from when it cannot read even the root", async () => {
    const s = new Store();
    const a = s.tree({ x: [FILE, 1] });
    const b = s.tree({ x: [FILE, 2] });
    const result = await diffTreesFrom(
      async () => {
        throw new ReadDeferred();
      },
      a,
      b,
      null,
      { maxChanges: 100, maxScanned: 1_000, maxDepth: 64 },
    );
    expect(result.stop).toBe("read");
    expect(result.changes).toEqual([]);
    expect(result.next).toEqual({ path: [], enter: true });
  });

  it("refuses to go deeper than its depth", async () => {
    const s = new Store();
    let spec: Spec = { f: [FILE, 1] };
    for (let i = 0; i < 5; i++) spec = { d: spec };
    const b = s.tree(spec);
    await expect(
      diffTreesFrom(s.read, null, b, null, { maxChanges: 100, maxScanned: 1_000, maxDepth: 4 }),
    ).rejects.toThrow(TreeDiffLimitError);
  });

  it("lists what diffTrees lists, however it is cut into slices (property)", async () => {
    const names = fc.constantFrom("a", "a-", "a.b", "a0", " ", "!", "b", "0", "z");
    const leaf = fc.tuple(fc.constantFrom(FILE, EXEC, LINK), fc.integer({ min: 0, max: 3 }));
    const spec: fc.Arbitrary<Spec> = fc.letrec<{ tree: Spec }>((tie) => ({
      tree: fc.dictionary(names, fc.oneof({ depthSize: "small" }, leaf, tie("tree")), {
        maxKeys: 5,
      }),
    })).tree as fc.Arbitrary<Spec>;
    await fc.assert(
      fc.asyncProperty(
        spec,
        spec,
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 40 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        async (oldSpec, newSpec, maxChanges, scanBudget, deferrals) => {
          const s = new Store();
          const a = s.tree(oldSpec);
          const b = s.tree(newSpec);
          const all = await oneShot(s, a, b);
          const listed = await resumed(
            s,
            a,
            b,
            { maxChanges, maxScanned: 1 + scanBudget },
            // Some reads deferred early on (later ones never: every run must end).
            (n) => n < 200 && n % 7 === 6 && (deferrals[n % deferrals.length] ?? false),
          );
          expect(listed).toEqual(all);
        },
      ),
      { numRuns: 300 },
    );
  });
});
