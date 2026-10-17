import { describe, expect, it } from "vitest";
import { mergeTrees, type TreeMerge } from "../../src/merge/merge-trees.js";
import { type Oid, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { enc, kinds, listed, store } from "./support.js";

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
