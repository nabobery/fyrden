import { describe, expect, it } from "vitest";
import { MergeBudget, MergeLimitError } from "../../src/merge/merge-trees.js";
import { baseTreeOf, MAX_VIRTUAL_DEPTH } from "../../src/merge/virtual-base.js";
import { type Oid, oidToHex } from "../../src/object/oid.js";
import { dec, listed, store } from "./support.js";

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
