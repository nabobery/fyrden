import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FileMerge, mergeFiles } from "../../src/merge/file-merge.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

// Against `git merge-file`. Where every file's lines are unique and each
// side keeps the base's lines in their order (no line moved), there is one
// way to align them, and we must agree with git exactly: clean where git
// is (with git's bytes), conflicting where git is. Where lines repeat or
// move, several shortest alignments exist and git's heuristics may pick
// another than ours: there the merge must still keep diff3's laws.

const enc = new TextEncoder();
const dec = new TextDecoder();
let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
});
afterAll(async () => {
  await sandbox.dispose();
});

async function gitMerge(base: string, ours: string, theirs: string) {
  const dir = await sandbox.tempDir("merge");
  await writeFile(join(dir, "base"), base);
  await writeFile(join(dir, "ours"), ours);
  await writeFile(join(dir, "theirs"), theirs);
  const result = await sandbox.git(["merge-file", "-p", "ours", "base", "theirs"], {
    cwd: dir,
    okExitCodes: Array.from({ length: 128 }, (_, i) => i),
  });
  return { clean: !result.stdout.includes("<<<<<<<"), text: result.stdout };
}

const merge = (base: string, ours: string, theirs: string): FileMerge =>
  mergeFiles(enc.encode(base), enc.encode(ours), enc.encode(theirs));

/** A base of distinct lines and two sides that delete some, insert lines of their own, and move none. */
const unique = fc
  .tuple(fc.integer({ min: 0, max: 12 }), fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }))
  .chain(([n]) => {
    const base = Array.from({ length: n }, (_, i) => `base ${i}\n`);
    const side = (name: string) =>
      fc
        .array(fc.tuple(fc.boolean(), fc.nat(2)), { minLength: n + 1, maxLength: n + 1 })
        .map((plan) => {
          const out: string[] = [];
          plan.forEach(([keep, adds], i) => {
            for (let k = 0; k < adds; k++) out.push(`${name} ${i}.${k}\n`);
            if (i < n && keep) out.push(base[i] as string);
          });
          return out.join("");
        });
    return fc.tuple(fc.constant(base.join("")), side("ours"), side("theirs"));
  });

const LINE = fc.constantFrom("a\n", "b\n", "c\n", "\n", "x\n");
const repeating = fc.array(LINE, { maxLength: 10 }).chain((base) => {
  const edit = fc
    .array(fc.tuple(fc.nat(base.length), fc.nat(2), fc.array(LINE, { maxLength: 2 })), {
      maxLength: 3,
    })
    .map((edits) => {
      const out = [...base];
      for (const [at, drop, add] of edits) out.splice(Math.min(at, out.length), drop, ...add);
      return out.join("");
    });
  return fc.tuple(fc.constant(base.join("")), edit, edit);
});

describe("mergeFiles against git merge-file", () => {
  it("agrees with git exactly where lines are unique", async () => {
    await fc.assert(
      fc.asyncProperty(unique, async ([base, ours, theirs]) => {
        const git = await gitMerge(base, ours, theirs);
        const result = merge(base, ours, theirs);
        expect(result.kind).toBe(git.clean ? "clean" : "conflict");
        if (result.kind === "clean") expect(dec.decode(result.bytes)).toBe(git.text);
      }),
      { numRuns: 300 },
    );
  }, 180_000);

  it("may differ from git where a line moves, both answers being valid", async () => {
    // Theirs moves `a` after lines it adds: git aligns on `b` and conflicts;
    // our shortest script aligns on `a`, and theirs alone changed the rest.
    expect((await gitMerge("a\nb\n", "a\n", "b\nc\na\n")).clean).toBe(false);
    const ours = merge("a\nb\n", "a\n", "b\nc\na\n");
    expect(ours.kind === "clean" ? dec.decode(ours.bytes) : ours.kind).toBe("b\nc\na\n");
  });

  it("keeps diff3's laws where lines repeat or move", () => {
    fc.assert(
      fc.property(repeating, ([base, ours, theirs]) => {
        const text = (m: FileMerge) => (m.kind === "clean" ? dec.decode(m.bytes) : m.kind);
        // One side unchanged: the other side, cleanly.
        expect(text(merge(base, base, theirs))).toBe(theirs);
        expect(text(merge(base, ours, base))).toBe(ours);
        // The same change on both sides: that change, cleanly.
        expect(text(merge(base, ours, ours))).toBe(ours);
        // The sides swapped: the same outcome.
        const forward = merge(base, ours, theirs);
        const backward = merge(base, theirs, ours);
        expect(forward.kind).toBe(backward.kind);
        if (forward.kind === "clean") expect(text(backward)).toBe(text(forward));
      }),
      { numRuns: 2_000 },
    );
  });
});
