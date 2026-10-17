import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DiffEntry, findExactRenames } from "../../src/diff/rename.js";
import { diffTrees, type TreeChange } from "../../src/diff/tree-diff.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import { parseTree } from "../../src/object/tree.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

// Against `git diff-tree -r --no-renames`: the same changes, in the same
// order, with the same statuses (A, D, M, T), modes and blob ids.

let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
});
afterAll(async () => {
  await sandbox.dispose();
});

const PATHS = ["a", "b.txt", "d/x", "d/y", "d/e/z", "d.txt", "d-", "e", "f/g/h", "x y"];
type FileSpec = { content: string; kind: "file" | "exec" | "link" };
const spec = fc.record({
  content: fc.constantFrom("1", "2", "3"),
  kind: fc.constantFrom("file", "file", "exec", "link" as const),
});
const tree = fc.dictionary(fc.constantFrom(...PATHS), spec, { maxKeys: 8 });

/** Writes `files` as the work tree (dropping any path under another that is a file) and returns its tree id. */
async function writeTree(dir: string, files: Record<string, FileSpec>): Promise<string> {
  for (const entry of await readdir(dir))
    if (entry !== ".git") await rm(join(dir, entry), { recursive: true });
  const paths = Object.keys(files).filter(
    (p) => !Object.keys(files).some((q) => q !== p && p.startsWith(`${q}/`)),
  );
  for (const path of paths) {
    const file = files[path] as FileSpec;
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    if (file.kind === "link") await symlink(file.content, full);
    else await writeFile(full, file.content, { mode: file.kind === "exec" ? 0o755 : 0o644 });
  }
  await sandbox.git(["add", "-A"], { cwd: dir });
  return (await sandbox.git(["write-tree"], { cwd: dir })).stdout.trim();
}

const readTree = (dir: string) => async (oid: Uint8Array) => {
  const body = await sandbox.gitBytes(["cat-file", "tree", oidToHex(oid as never)], { cwd: dir });
  return parseTree(body).value;
};

const asRaw = (c: TreeChange) =>
  `${(c.oldMode ?? 0).toString(8).padStart(6, "0")} ${(c.newMode ?? 0).toString(8).padStart(6, "0")} ${
    c.oldOid ? oidToHex(c.oldOid) : "0".repeat(40)
  } ${c.newOid ? oidToHex(c.newOid) : "0".repeat(40)} ${
    { added: "A", removed: "D", modified: "M", type_changed: "T" }[c.status]
  }\t${c.path}`;

const asRenameRaw = (e: DiffEntry) =>
  e.status === "renamed"
    ? `${(e.oldMode ?? 0).toString(8).padStart(6, "0")} ${(e.newMode ?? 0).toString(8).padStart(6, "0")} ${
        e.oldOid ? oidToHex(e.oldOid) : ""
      } ${e.newOid ? oidToHex(e.newOid) : ""} R100\t${e.previousPath}\t${e.path}`
    : asRaw(e);

describe("diffTrees against git diff-tree", () => {
  it("lists the same changes, in the same order, and resumes a listing exactly", async () => {
    const dir = await sandbox.tempDir("trees");
    await sandbox.git(["init", "-q"], { cwd: dir });
    await fc.assert(
      fc.asyncProperty(tree, tree, async (before, after) => {
        // Both trees in one repository, so either side's objects can be read.
        const a = await writeTree(dir, before);
        const b = await writeTree(dir, after);
        const expected = (
          await sandbox.git(["diff-tree", "-r", "--no-renames", "--raw", "--full-index", a, b], {
            cwd: dir,
          })
        ).stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => line.slice(1));
        const read = readTree(dir);
        const { changes } = await diffTrees(read, oidFromHex(a), oidFromHex(b));
        expect(changes.map(asRaw)).toEqual(expected);
        // Two at a time, resumed after each page's last path: the same list.
        const paged: TreeChange[] = [];
        let cursor: Uint8Array | undefined;
        for (;;) {
          const page = await diffTrees(read, oidFromHex(a), oidFromHex(b), {
            maxChanges: 2,
            ...(cursor && { after: cursor }),
          });
          paged.push(...page.changes);
          if (!page.truncated) break;
          cursor = page.changes.at(-1)?.pathBytes;
        }
        expect(paged.map(asRaw)).toEqual(expected);
        // Exact renames, as `-M100%` finds them.
        const renamed = (
          await sandbox.git(["diff-tree", "-r", "-M100%", "--raw", "--full-index", a, b], {
            cwd: dir,
          })
        ).stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => line.slice(1));
        expect(findExactRenames(changes).map(asRenameRaw)).toEqual(renamed);
      }),
      { numRuns: 60 },
    );
  }, 300_000);
});
