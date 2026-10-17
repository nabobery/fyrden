import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeTrees } from "../../src/merge/merge-trees.js";
import { baseTreeOf, type History } from "../../src/merge/virtual-base.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import { parseTree } from "../../src/object/tree.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

// Criss-cross histories against `git merge-tree` (which merges the merge
// bases into a virtual base): where git merges cleanly and our virtual base
// merges cleanly, the trees are git's; where git conflicts, so do we (or
// we say the merge needs a person).

let sandbox: GitSandbox;
let dir: string;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  dir = await sandbox.tempDir("criss-cross");
  await sandbox.git(["init", "-q"], { cwd: dir });
});
afterAll(async () => {
  await sandbox.dispose();
});

const git = async (args: string[]) => (await sandbox.git(args, { cwd: dir })).stdout.trim();

/** A commit of `files` with `parents`. */
async function commit(files: Record<string, string>, parents: string[]): Promise<string> {
  await sandbox.git(["rm", "-rq", "--cached", "--ignore-unmatch", "."], { cwd: dir });
  for (const [path, text] of Object.entries(files)) {
    await writeFile(join(dir, path), text);
    await sandbox.git(["add", path], { cwd: dir });
  }
  const tree = await git(["write-tree"]);
  return git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "x"]);
}

const history: History = {
  mergeBases: async (one, others) =>
    (
      await sandbox.git(["merge-base", "--all", oidToHex(one), ...others.map((o) => oidToHex(o))], {
        cwd: dir,
        okExitCodes: [0, 1],
      })
    ).stdout
      .split("\n")
      .filter(Boolean)
      .map(oidFromHex),
  treeOf: async (c) => oidFromHex(await git(["rev-parse", `${oidToHex(c)}^{tree}`])),
};
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

const lines = (name: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${name} ${i}\n`).join("");
const VALUE = fc.constantFrom("base", "left", "right", "both");

describe("virtual bases against git merge-tree", () => {
  it("merges criss-cross histories as git does, or says a person must", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ b1: VALUE, c1: VALUE, b2: VALUE, c2: VALUE, f: VALUE, g: VALUE }),
        async (pick) => {
          const file = (tag: string) =>
            tag === "base" ? lines("f", 4) : `${lines("f", 2)}${tag}\n${lines("g", 2)}`;
          const a = await commit({ f: lines("f", 4), g: lines("g", 4) }, []);
          const b1 = await commit({ f: file(pick.b1), g: lines("g", 4) }, [a]);
          const c1 = await commit({ f: lines("f", 4), g: file(pick.c1) }, [a]);
          // Each side merges the other: two merge bases from here on.
          const merged = { f: file(pick.b1), g: file(pick.c1) };
          const b2 = await commit({ ...merged, f: pick.f === "base" ? merged.f : file(pick.f) }, [
            b1,
            c1,
          ]);
          const c2 = await commit({ ...merged, g: pick.g === "base" ? merged.g : file(pick.g) }, [
            c1,
            b1,
          ]);
          const result = await sandbox.git(
            ["merge-tree", "--write-tree", "--name-only", "-X", "no-renames", b2, c2],
            {
              cwd: dir,
              okExitCodes: [0, 1],
            },
          );
          const [gitTree, conflicted] = result.stdout.split("\n");
          const gitClean = conflicted === "";
          const bases = await history.mergeBases(oidFromHex(b2), [oidFromHex(c2)]);
          expect(bases.length).toBeGreaterThan(0);
          const base = await baseTreeOf(source, history, bases);
          if (base.kind === "manual") {
            expect(gitClean).toBe(false);
            return;
          }
          const ours = await mergeTrees(
            {
              // The virtual base's own objects are not in git's store: read them from the merge.
              readTree: async (oid) => {
                const made = base.objects.find((o) => oidToHex(o.oid) === oidToHex(oid as never));
                return made ? parseTree(made.bytes).value : source.readTree(oid);
              },
              readBlob: async (oid, maxBytes) => {
                const made = base.objects.find((o) => oidToHex(o.oid) === oidToHex(oid as never));
                return made ? made.bytes : source.readBlob(oid, maxBytes);
              },
            },
            base.tree,
            await history.treeOf(oidFromHex(b2)),
            await history.treeOf(oidFromHex(c2)),
          );
          if (gitClean)
            expect(ours.kind === "clean" ? oidToHex(ours.tree) : ours.kind).toBe(gitTree);
          else expect(ours.kind).toBe("conflicts");
        },
      ),
      { numRuns: 60 },
    );
  }, 300_000);
});
