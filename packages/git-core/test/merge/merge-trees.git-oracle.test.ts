import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeTrees } from "../../src/merge/merge-trees.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import { parseTree } from "../../src/object/tree.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

// Against `git merge-tree --write-tree -X no-renames`: a clean merge makes
// git's tree, and a conflicted one conflicts on git's paths. Contents have
// unique lines (one way to align them) and paths no file/directory clashes;
// those cases and renames are tested on their own (git follows renames).

let sandbox: GitSandbox;
let dir: string;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  dir = await sandbox.tempDir("merge-trees");
  await sandbox.git(["init", "-q"], { cwd: dir });
});
afterAll(async () => {
  await sandbox.dispose();
});

const PATHS = ["a", "b.txt", "d/x", "d/y", "e/f/g", "h"];
type Files = Record<string, { lines: string[]; exec: boolean }>;

async function commitOf(files: Files): Promise<string> {
  for (const entry of await readdir(dir))
    if (entry !== ".git") await rm(join(dir, entry), { recursive: true });
  for (const [path, file] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.lines.join(""), { mode: file.exec ? 0o755 : 0o644 });
  }
  await sandbox.git(["add", "-A"], { cwd: dir });
  const tree = (await sandbox.git(["write-tree"], { cwd: dir })).stdout.trim();
  return (await sandbox.git(["commit-tree", tree, "-m", "x"], { cwd: dir })).stdout.trim();
}

const treeOf = async (commit: string) =>
  (await sandbox.git(["rev-parse", `${commit}^{tree}`], { cwd: dir })).stdout.trim();

const source = {
  readTree: async (oid: Uint8Array) =>
    parseTree(await sandbox.gitBytes(["cat-file", "tree", oidToHex(oid as never)], { cwd: dir }))
      .value,
  readBlob: async (oid: Uint8Array, maxBytes: number) => {
    const bytes = await sandbox.gitBytes(["cat-file", "blob", oidToHex(oid as never)], {
      cwd: dir,
    });
    return bytes.length > maxBytes ? undefined : bytes;
  },
};

const base = fc
  .dictionary(fc.constantFrom(...PATHS), fc.boolean(), { maxKeys: 6 })
  .map((present) => {
    const files: Files = {};
    for (const [path, exec] of Object.entries(present))
      files[path] = { lines: Array.from({ length: 4 }, (_, i) => `${path} base ${i}\n`), exec };
    return files;
  });

/** A side: each base file kept, deleted, edited (unique lines) or made executable; some paths added. */
const side = (name: string, from: Files) =>
  fc
    .record({
      plan: fc.array(fc.constantFrom("keep", "keep", "delete", "edit", "chmod"), {
        minLength: PATHS.length,
        maxLength: PATHS.length,
      }),
      adds: fc.subarray(PATHS),
      at: fc.nat(4),
    })
    .map(({ plan, adds, at }) => {
      const out: Files = {};
      PATHS.forEach((path, i) => {
        const file = from[path];
        if (!file) return;
        const step = plan[i];
        if (step === "delete") return;
        if (step === "edit") {
          const lines = [...file.lines];
          lines.splice(at % (lines.length + 1), 1, `${path} ${name} edit\n`);
          out[path] = { lines, exec: file.exec };
        } else out[path] = { lines: file.lines, exec: step === "chmod" ? !file.exec : file.exec };
      });
      for (const path of adds)
        if (!from[path]) out[path] = { lines: [`${path} ${name} added\n`], exec: false };
      return out;
    });

describe("mergeTrees against git merge-tree", () => {
  it("makes git's tree where git merges cleanly, and conflicts on git's paths", async () => {
    await fc.assert(
      fc.asyncProperty(
        base.chain((b) => fc.tuple(fc.constant(b), side("ours", b), side("theirs", b))),
        async ([b, o, t]) => {
          const [bc, oc, tc] = [await commitOf(b), await commitOf(o), await commitOf(t)];
          const result = await sandbox.git(
            [
              "merge-tree",
              "--write-tree",
              "--name-only",
              "-X",
              "no-renames",
              `--merge-base=${bc}`,
              oc,
              tc,
            ],
            { cwd: dir, okExitCodes: [0, 1] },
          );
          const [gitTree = "", ...rest] = result.stdout.split("\n");
          const gitConflicts = rest.slice(0, rest.indexOf("")).sort();
          const ours = await mergeTrees(
            source,
            oidFromHex(await treeOf(bc)),
            oidFromHex(await treeOf(oc)),
            oidFromHex(await treeOf(tc)),
          );
          if (gitConflicts.length === 0) {
            expect(ours.kind).toBe("clean");
            if (ours.kind === "clean") expect(oidToHex(ours.tree)).toBe(gitTree);
          } else {
            expect(ours.kind).toBe("conflicts");
            if (ours.kind === "conflicts")
              expect([...new Set(ours.conflicts.map((c) => c.path))].sort()).toEqual(gitConflicts);
          }
        },
      ),
      { numRuns: 120 },
    );
  }, 300_000);
});

describe("mergeTrees with a file and a directory of one name", () => {
  const merge = async (b: Files, o: Files, t: Files) => {
    const [bc, oc, tc] = [await commitOf(b), await commitOf(o), await commitOf(t)];
    const git = await sandbox.git(
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-X",
        "no-renames",
        `--merge-base=${bc}`,
        oc,
        tc,
      ],
      { cwd: dir, okExitCodes: [0, 1] },
    );
    const ours = await mergeTrees(
      source,
      oidFromHex(await treeOf(bc)),
      oidFromHex(await treeOf(oc)),
      oidFromHex(await treeOf(tc)),
    );
    return { gitClean: git.stdout.split("\n")[1] === "", gitTree: git.stdout.split("\n")[0], ours };
  };
  const file = (text: string) => ({ lines: [`${text}\n`], exec: false });

  it("merges a file deleted on one side and a directory of its name added on the other, as git does", async () => {
    const { gitClean, gitTree, ours } = await merge({ d: file("base") }, {}, { "d/f": file("f") });
    expect(gitClean).toBe(true);
    expect(ours.kind === "clean" ? oidToHex(ours.tree) : ours.kind).toBe(gitTree);
  });

  it("conflicts where a file and a directory of one name both stay, at that path (git moves the file aside)", async () => {
    const added = await merge({}, { x: file("x") }, { "x/y": file("y") });
    expect(added.gitClean).toBe(false);
    expect(
      added.ours.kind === "conflicts" ? added.ours.conflicts.map((c) => [c.kind, c.path]) : [],
    ).toEqual([["file_directory", "x"]]);
    const replaced = await merge({ d: file("base") }, { d: file("changed") }, { "d/f": file("f") });
    expect(replaced.gitClean).toBe(false);
    expect(replaced.ours.kind).toBe("conflicts");
  });
});

describe("mergeTrees with legacy file modes", () => {
  it("writes a directory both sides changed alike as git does, and keeps one only one side changed", async () => {
    const hash = async (text: string) =>
      (
        await sandbox.git(["hash-object", "-w", "--stdin"], { cwd: dir, input: text })
      ).stdout.trim();
    const mktree = async (lines: string[]) =>
      (
        await sandbox.git(["mktree"], { cwd: dir, input: lines.map((l) => `${l}\n`).join("") })
      ).stdout.trim();
    const [f, g, g2, x, y] = await Promise.all(["f\n", "g\n", "G\n", "x\n", "y\n"].map(hash));
    const d0 = await mktree([`100664 blob ${f}\tf`, `100644 blob ${g}\tg`]);
    const d1 = await mktree([`100664 blob ${f}\tf`, `100644 blob ${g2}\tg`]);
    const commit = async (lines: string[]) =>
      (
        await sandbox.git(["commit-tree", await mktree(lines), "-m", "x"], { cwd: dir })
      ).stdout.trim();
    const base = await commit([`040000 tree ${d0}\td`]);
    for (const [oursDir, theirsDir] of [
      [d1, d1],
      [d0, d1],
    ]) {
      const ours = await commit([`040000 tree ${oursDir}\td`, `100644 blob ${x}\tx`]);
      const theirs = await commit([`040000 tree ${theirsDir}\td`, `100644 blob ${y}\ty`]);
      const git = (
        await sandbox.git(
          ["merge-tree", "--write-tree", "-X", "no-renames", `--merge-base=${base}`, ours, theirs],
          {
            cwd: dir,
          },
        )
      ).stdout.trim();
      const merged = await mergeTrees(
        source,
        oidFromHex(await treeOf(base)),
        oidFromHex(await treeOf(ours)),
        oidFromHex(await treeOf(theirs)),
      );
      expect(merged.kind === "clean" ? oidToHex(merged.tree) : merged.kind).toBe(git);
    }
  });
});
