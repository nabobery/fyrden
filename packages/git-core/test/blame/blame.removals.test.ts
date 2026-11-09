import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_RENAME_CHECK_BYTES,
  MAX_RENAME_CHECK_TREES,
  type RenameCheckBudget,
  removals,
  renameCheckBudget,
  UnreadableTree,
} from "../../src/blame/removals.js";
import type { BlameSource } from "../../src/blame/walk.js";
import { type Oid, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { encodeTree, FILE_MODES, type TreeEntry } from "../../src/object/tree.js";

/*
 * What going from one tree to another removes, as the rename rule asks it: at
 * the first removal, or (with an oid) whether an identical copy was removed
 * anywhere, under one step's budget of trees queued and bytes read.
 */

const enc = (text: string) => new TextEncoder().encode(text);
const blob = (text: string): Oid =>
  oidFromHex(createHash("sha1").update(`blob ${text}`).digest("hex"));

type Spec = { [name: string]: string | Spec | { mode: number; oid: Oid } };

/** Trees built from nested specs, as git writes them, read back through `tree`. */
class Trees {
  readonly bodies = new Map<string, Uint8Array>();
  /** Each `tree` call: the oid's backing buffer size, and the body size, or "too_large". */
  readonly calls: { buffer: number; got: number | "too_large" }[] = [];

  make(spec: Spec): Oid {
    const entries: TreeEntry[] = [];
    for (const [name, value] of Object.entries(spec)) {
      if (typeof value === "string") {
        const symlink = value.startsWith("120000 ");
        entries.push({
          mode: symlink ? FILE_MODES.symlink : FILE_MODES.file,
          name: enc(name),
          oid: blob(symlink ? value.slice(7) : value),
        });
      } else if ("mode" in value && "oid" in value) {
        entries.push({ mode: value.mode as number, name: enc(name), oid: value.oid as Oid });
      } else {
        entries.push({ mode: FILE_MODES.tree, name: enc(name), oid: this.make(value as Spec) });
      }
    }
    const body = encodeTree(entries);
    const oid = oidFromHex(createHash("sha1").update("tree ").update(body).digest("hex"));
    this.bodies.set(oidToHex(oid), body);
    return oid;
  }

  source(): BlameSource {
    return {
      tree: async (oid: Oid, maxBytes: number) => {
        const body = this.bodies.get(oidToHex(oid));
        if (!body) throw new Error("no such tree");
        const got = body.length > maxBytes ? ("too_large" as const) : body.length;
        this.calls.push({ buffer: oid.buffer.byteLength, got });
        return got === "too_large" ? got : body;
      },
    } as unknown as BlameSource;
  }
}

async function check(
  from: Spec,
  to: Spec,
  identical?: string,
  budget: RenameCheckBudget = renameCheckBudget(),
) {
  const trees = new Trees();
  const a = trees.make(from);
  const b = trees.make(to);
  let work = 0;
  const result = await removals(
    trees.source(),
    a,
    b,
    identical === undefined ? undefined : blob(identical),
    budget,
    (units) => {
      work += units;
    },
  );
  return { result, trees, work, budget };
}

describe("what a change removes", () => {
  it("nothing, for the same tree, without reading it", async () => {
    const { result, trees } = await check({ f: "x" }, { f: "x" });
    expect(result).toBe("none");
    expect(trees.calls).toEqual([]);
  });

  it("nothing, for additions, edits and a mode change within a type", async () => {
    const exec = { mode: FILE_MODES.executable, oid: blob("run") };
    const { result } = await check(
      { a: "1", d: { k: "1" }, run: "run" },
      { a: "2", b: "new", d: { k: "2", n: "new" }, run: exec },
    );
    expect(result).toBe("none");
  });

  it("a deleted file, at the first one", async () => {
    expect((await check({ f: "x", g: "y" }, { f: "x2" })).result).toBe("some");
  });

  it("a file deep in a directory present on both sides", async () => {
    const { result, trees } = await check(
      { d: { e: { g: "y", h: "z" } }, f: "x" },
      { d: { e: { h: "z" } }, f: "x2" },
    );
    expect(result).toBe("some");
    expect(trees.calls).toHaveLength(6);
  });

  it("a type change: file to symlink, and a submodule's", async () => {
    expect((await check({ g: "t" }, { g: "120000 t" })).result).toBe("some");
    const gitlink = { mode: FILE_MODES.gitlink, oid: blob("sub") };
    expect((await check({ s: gitlink }, {})).result).toBe("some");
  });

  it("a removed directory counts unread when the first removal is enough", async () => {
    const { result, trees } = await check({ gone: { g: "y" }, f: "x" }, { f: "x2" });
    expect(result).toBe("some");
    expect(trees.calls).toHaveLength(2);
  });

  it("a directory replaced by a file, and a file by a directory", async () => {
    expect((await check({ p: { q: "1" } }, { p: "1" })).result).toBe("some");
    expect((await check({ p: "1" }, { p: { q: "1" } })).result).toBe("some");
  });
});

describe("an identical copy removed, anywhere", () => {
  it("found among the removed files", async () => {
    expect((await check({ g: "A", h: "B" }, { f: "A" }, "A")).result).toBe("identical");
  });

  it("found inside a removed directory, which is read", async () => {
    const { result } = await check({ gone: { g: "abc" }, f: "abx" }, { f: "abc" }, "abc");
    expect(result).toBe("identical");
  });

  it("found in a nested removed directory, and in one replaced by a file", async () => {
    expect((await check({ a: { b: { c: { g: "A" } } } }, { f: "A" }, "A")).result).toBe(
      "identical",
    );
    expect((await check({ p: { g: "A" } }, { p: "other", f: "A" }, "A")).result).toBe("identical");
  });

  it("found where a file's type changed but its content didn't", async () => {
    expect((await check({ g: "A" }, { g: "120000 A", f: "A" }, "A")).result).toBe("identical");
  });

  it("only removals: an identical file still present doesn't count", async () => {
    expect((await check({ g: "A", h: "B" }, { g: "A", f: "A" }, "A")).result).toBe("some");
    expect((await check({ g: "A" }, { g: "A", f: "A" }, "A")).result).toBe("none");
  });

  it("an empty removed directory removes nothing", async () => {
    expect((await check({ e: {}, f: "x" }, { f: "y" }, "y")).result).toBe("none");
  });
});

describe("the budget", () => {
  const wide = (n: number, side: string): Spec =>
    Object.fromEntries(Array.from({ length: n }, (_, k) => [`d${k}`, { k: `${side}${k}` }]));

  it("is shared and spent when a tree is queued: 127 differing children fit, 128 don't", async () => {
    const fits = await check(wide(127, "a"), wide(127, "b"));
    expect(fits.result).toBe("none");
    expect(fits.budget.trees).toBe(0);
    expect(fits.trees.calls).toHaveLength(MAX_RENAME_CHECK_TREES);
    const over = await check(wide(128, "a"), wide(128, "b"));
    expect(over.result).toBe("unknown");
    // Only the root pair was read: the children were queued until one didn't fit.
    expect(over.trees.calls).toHaveLength(2);
  });

  it("a wide root never queues more than the budget", async () => {
    const { result, trees, budget } = await check(wide(300, "a"), wide(300, "b"));
    expect(result).toBe("unknown");
    expect(budget.trees).toBeGreaterThanOrEqual(0);
    expect(trees.calls).toHaveLength(2);
  });

  it("a removed directory costs one tree; an identity check stops at the last that fits", async () => {
    const budget = { trees: 3, bytes: MAX_RENAME_CHECK_BYTES };
    expect((await check({ gone: { g: "A" }, f: "x" }, { f: "y" }, "A", budget)).result).toBe(
      "identical",
    );
    expect(budget.trees).toBe(0);
    const less = { trees: 2, bytes: MAX_RENAME_CHECK_BYTES };
    expect((await check({ gone: { g: "A" }, f: "x" }, { f: "y" }, "A", less)).result).toBe(
      "unknown",
    );
  });

  it("reads a tree of exactly the bytes left, and not one byte more", async () => {
    const trees = new Trees();
    const a = trees.make({ f: "x", g: "y" });
    const b = trees.make({ f: "x2", g: "y" });
    const size = (trees.bodies.get(oidToHex(a)) as Uint8Array).length;
    const sizeB = (trees.bodies.get(oidToHex(b)) as Uint8Array).length;
    const exact = { trees: 2, bytes: size + sizeB };
    expect(await removals(trees.source(), a, b, undefined, exact, () => {})).toBe("none");
    expect(exact.bytes).toBe(0);
    const short = { trees: 2, bytes: size + sizeB - 1 };
    expect(await removals(trees.source(), a, b, undefined, short, () => {})).toBe("unknown");
    expect(trees.calls.at(-1)?.got).toBe("too_large");
  });

  it("holds copied ids, never views that would keep a tree's body", async () => {
    const { trees } = await check(
      { d: { e: { g: "1" } }, gone: { x: "2" }, f: "x" },
      { d: { e: { g: "3" } }, f: "y" },
      "nothing like it",
    );
    expect(trees.calls.length).toBeGreaterThan(3);
    for (const call of trees.calls) expect(call.buffer).toBe(20);
  });

  it("charges engine work for each tree it walks", async () => {
    const { work } = await check({ g: "1", f: "x" }, { f: "y" });
    expect(work).toBeGreaterThan(0);
  });
});

it("a tree that doesn't parse is unreadable", async () => {
  const trees = new Trees();
  const a = trees.make({ f: "x" });
  const bad = oidFromHex("ab".repeat(20));
  trees.bodies.set(oidToHex(bad), enc("100644 broken"));
  await expect(
    removals(trees.source(), a, bad, undefined, renameCheckBudget(), () => {}),
  ).rejects.toBeInstanceOf(UnreadableTree);
});
