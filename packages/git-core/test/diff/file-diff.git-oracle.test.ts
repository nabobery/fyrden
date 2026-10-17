import { readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffFile } from "../../src/diff/file-diff.js";
import { formatFileHeader } from "../../src/diff/patch.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

// Against git: our patch bytes, given to `git apply`, turn the old file into
// the new one byte for byte, whatever its bytes and its name, and change no
// more lines than `git diff` does (the line diff is a shortest one; git's
// heuristics may change more). Hunk boundaries may differ from git's.

const enc = new TextEncoder();
let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
});
afterAll(async () => {
  await sandbox.dispose();
});

const LINE = fc.constantFrom(
  enc.encode("a\n"),
  enc.encode("b\n"),
  enc.encode("\n"),
  enc.encode("  indented\n"),
  enc.encode("é\n"),
  enc.encode("crlf\r\n"),
  new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]),
  new Uint8Array([0xff, 0xfe, 0x0a]),
  enc.encode("tab\there\n"),
);
const NAMES = ["f", "sp ace", "tab\tname", "new\nline", 'quo"te', "back\\slash", "é"];

function bytesOf(lines: Uint8Array[], finalNewline: boolean): Uint8Array {
  const all = new Uint8Array(lines.reduce((n, l) => n + l.length, 0));
  let at = 0;
  for (const line of lines) {
    all.set(line, at);
    at += line.length;
  }
  return finalNewline || all.length === 0 ? all : all.subarray(0, all.length - 1);
}

describe("diffFile against git", () => {
  it("makes patch bytes git applies exactly, changing no more lines than git diff", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(LINE, { maxLength: 25 }),
        fc.array(LINE, { maxLength: 25 }),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom(...NAMES),
        async (a, b, endA, endB, name) => {
          const oldBytes = bytesOf(a, endA);
          const newBytes = bytesOf(b, endB);
          const diff = diffFile(oldBytes, newBytes);
          if (diff.kind !== "text") return expect.fail(diff.kind);
          expect(diff.approximate).toBe(false);
          const dir = await sandbox.tempDir("apply");
          await writeFile(join(dir, name), oldBytes);
          if (diff.hunks.length > 0) {
            const path = enc.encode(name);
            const header = formatFileHeader({
              status: "modified",
              oldPath: path,
              newPath: path,
              oldMode: "100644",
              newMode: "100644",
              oldOid: "1".repeat(40),
              newOid: "2".repeat(40),
            });
            const patch = new Uint8Array([...enc.encode(header), ...diff.patch]);
            await writeFile(join(dir, "p.diff"), patch);
            await sandbox.git(["apply", "p.diff"], { cwd: dir });
          }
          expect(new Uint8Array(await readFile(join(dir, name)))).toEqual(newBytes);
          await writeFile(join(dir, "old"), oldBytes);
          await writeFile(join(dir, "new"), newBytes);
          const { stdout } = await sandbox.git(["diff", "--no-index", "--numstat", "old", "new"], {
            cwd: dir,
            okExitCodes: [0, 1],
          });
          const [added = "0", deleted = "0"] = stdout.trim().split(/\s+/);
          expect(diff.additions + diff.deletions).toBeLessThanOrEqual(
            Number(added) + Number(deleted),
          );
        },
      ),
      { numRuns: 200 },
    );
  }, 180_000);
});

describe("a change of kind against git", () => {
  it("applies as a removal and then an addition, as git writes it", async () => {
    const dir = await sandbox.tempDir("kind");
    const path = enc.encode("link");
    const oldBytes = enc.encode("regular content\n");
    const target = enc.encode("target");
    await writeFile(join(dir, "link"), oldBytes);
    const removal = diffFile(oldBytes, new Uint8Array(0));
    const addition = diffFile(new Uint8Array(0), target);
    if (removal.kind !== "text" || addition.kind !== "text") return expect.fail();
    const removed = formatFileHeader({
      status: "removed",
      oldPath: path,
      newPath: null,
      oldMode: "100644",
      newMode: null,
      oldOid: "1".repeat(40),
      newOid: null,
    });
    const added = formatFileHeader({
      status: "added",
      oldPath: null,
      newPath: path,
      oldMode: null,
      newMode: "120000",
      oldOid: null,
      newOid: "2".repeat(40),
    });
    await writeFile(
      join(dir, "p.diff"),
      new Uint8Array([
        ...enc.encode(removed),
        ...removal.patch,
        ...enc.encode(added),
        ...addition.patch,
      ]),
    );
    await sandbox.git(["apply", "p.diff"], { cwd: dir });
    expect(await readlink(join(dir, "link"))).toBe("target");
    expect(() =>
      formatFileHeader({
        status: "changed",
        oldPath: path,
        newPath: path,
        oldMode: "100644",
        newMode: "120000",
        oldOid: "1".repeat(40),
        newOid: "2".repeat(40),
      }),
    ).toThrow(RangeError);
  });
});
