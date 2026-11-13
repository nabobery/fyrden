// Which workflow files a commit has: `.fyrden/workflows` when anything is
// at that path, otherwise `.github/workflows`, never both; the direct
// regular files named *.yml or *.yaml; bounded listings and results; and a
// listing that is too large or fails never becoming a fallback.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type DirectoryEntry,
  type DirectoryListing,
  discoverWorkflows,
  MAX_LISTED_ENTRIES,
  MAX_SKIPPED_NAME_BYTES,
  MAX_SKIPPED_REPORTED,
  MAX_WORKFLOW_FILES,
  type WorkflowDirectory,
  type WorkflowTree,
} from "../../src/ci/discover.js";

const FILE = 0o100644;
const EXECUTABLE = 0o100755;
const SYMLINK = 0o120000;
const TREE = 0o040000;
const SUBMODULE = 0o160000;

const encoder = new TextEncoder();
const entry = (
  name: string | Uint8Array,
  mode = FILE,
  oid = `oid-${String(name)}`,
): DirectoryEntry => ({
  name: typeof name === "string" ? encoder.encode(name) : name,
  mode,
  oid,
});
const directory = (...entries: DirectoryEntry[]): DirectoryListing => ({
  kind: "directory",
  entries,
});
const ABSENT: DirectoryListing = { kind: "absent" };

/** An in-memory tree recording which directories discovery asked for. */
function fakeTree(listings: Partial<Record<WorkflowDirectory, DirectoryListing>>) {
  const asked: WorkflowDirectory[] = [];
  const tree: WorkflowTree = {
    list: async (path) => {
      asked.push(path);
      return listings[path] ?? ABSENT;
    },
  };
  return { tree, asked };
}

describe("discoverWorkflows", () => {
  it("uses .fyrden/workflows when both directories hold workflows, and never reads the other", async () => {
    const { tree, asked } = fakeTree({
      ".fyrden/workflows": directory(entry("ci.yml")),
      ".github/workflows": directory(entry("github.yml")),
    });
    const found = await discoverWorkflows(tree);
    expect(found).toEqual({
      ok: true,
      directory: ".fyrden/workflows",
      files: [{ path: ".fyrden/workflows/ci.yml", name: "ci.yml", oid: "oid-ci.yml" }],
      skipped: [],
      skippedCount: 0,
    });
    expect(asked).toEqual([".fyrden/workflows"]);
  });

  it("does not fall back when .fyrden/workflows holds no workflow file", async () => {
    const { tree, asked } = fakeTree({
      ".fyrden/workflows": directory(entry("README.md")),
      ".github/workflows": directory(entry("ci.yml")),
    });
    const found = await discoverWorkflows(tree);
    expect(found).toMatchObject({ ok: true, directory: ".fyrden/workflows", files: [] });
    expect(asked).toEqual([".fyrden/workflows"]);
  });

  it("does not fall back when .fyrden/workflows is an empty listing", async () => {
    const { tree } = fakeTree({
      ".fyrden/workflows": directory(),
      ".github/workflows": directory(entry("ci.yml")),
    });
    expect(await discoverWorkflows(tree)).toMatchObject({
      directory: ".fyrden/workflows",
      files: [],
    });
  });

  it("uses .github/workflows when .fyrden/workflows is absent", async () => {
    const { tree, asked } = fakeTree({ ".github/workflows": directory(entry("ci.yml")) });
    expect(await discoverWorkflows(tree)).toMatchObject({
      ok: true,
      directory: ".github/workflows",
      files: [{ path: ".github/workflows/ci.yml", name: "ci.yml" }],
    });
    expect(asked).toEqual([".fyrden/workflows", ".github/workflows"]);
  });

  it("finds no directory when neither exists", async () => {
    const { tree } = fakeTree({});
    expect(await discoverWorkflows(tree)).toEqual({
      ok: true,
      directory: null,
      files: [],
      skipped: [],
      skippedCount: 0,
    });
  });

  it("refuses, without falling back, when .fyrden/workflows is not a directory", async () => {
    const { tree, asked } = fakeTree({
      ".fyrden/workflows": { kind: "not-a-directory" },
      ".github/workflows": directory(entry("ci.yml")),
    });
    expect(await discoverWorkflows(tree)).toEqual({
      ok: false,
      code: "not_a_directory",
      directory: ".fyrden/workflows",
    });
    expect(asked).toEqual([".fyrden/workflows"]);
  });

  it("refuses when .github/workflows is not a directory", async () => {
    const { tree } = fakeTree({ ".github/workflows": { kind: "not-a-directory" } });
    expect(await discoverWorkflows(tree)).toEqual({
      ok: false,
      code: "not_a_directory",
      directory: ".github/workflows",
    });
  });

  it("refuses, without falling back, a listing the tree reports as too large", async () => {
    const { tree, asked } = fakeTree({
      ".fyrden/workflows": { kind: "too-large" },
      ".github/workflows": directory(entry("ci.yml")),
    });
    expect(await discoverWorkflows(tree)).toEqual({
      ok: false,
      code: "directory_too_large",
      directory: ".fyrden/workflows",
    });
    expect(asked).toEqual([".fyrden/workflows"]);
  });

  it("refuses a listing longer than the bound even when the tree returns it", async () => {
    const entries = Array.from({ length: MAX_LISTED_ENTRIES + 1 }, (_, i) => entry(`n${i}.txt`));
    const { tree } = fakeTree({ ".github/workflows": directory(...entries) });
    expect(await discoverWorkflows(tree)).toMatchObject({ ok: false, code: "directory_too_large" });
    const exactly = entries.slice(0, MAX_LISTED_ENTRIES);
    expect(
      await discoverWorkflows(fakeTree({ ".github/workflows": directory(...exactly) }).tree),
    ).toMatchObject({ ok: true, files: [], skippedCount: MAX_LISTED_ENTRIES });
  });

  it("lets a failing read reject, and never reads the other directory", async () => {
    const asked: WorkflowDirectory[] = [];
    const tree: WorkflowTree = {
      list: async (path) => {
        asked.push(path);
        throw new Error("read limit");
      },
    };
    await expect(discoverWorkflows(tree)).rejects.toThrow("read limit");
    expect(asked).toEqual([".fyrden/workflows"]);
  });

  it("takes direct regular files named *.yml or *.yaml, in byte order", async () => {
    const { tree } = fakeTree({
      ".github/workflows": directory(
        entry("z.yaml"),
        entry("b.yml", EXECUTABLE),
        entry("a.yml"),
        entry("é.yml"),
        entry("A.yml"),
      ),
    });
    const found = await discoverWorkflows(tree);
    expect(found.ok && found.files.map((f) => f.name)).toEqual([
      "A.yml",
      "a.yml",
      "b.yml",
      "z.yaml",
      "é.yml",
    ]);
  });

  it("skips other entries with a reason", async () => {
    const { tree } = fakeTree({
      ".github/workflows": directory(
        entry("ci.yml"),
        entry("nested", TREE),
        entry("link.yml", SYMLINK),
        entry("module.yml", SUBMODULE),
        entry("folder.yml", TREE),
        entry("group.yml", 0o100664),
        entry("loose.yml", 0o100777),
        entry("bare.yml", 0o100000),
        entry("notes.md"),
        entry("CI.YML"),
        entry("ci.yml.bak"),
        entry(new Uint8Array([0x66, 0xff, 0x2e, 0x79, 0x6d, 0x6c])),
      ),
    });
    const found = await discoverWorkflows(tree);
    if (!found.ok) throw new Error("refused");
    expect(found.files.map((f) => f.name)).toEqual(["ci.yml"]);
    expect(found.skipped).toEqual([
      { name: "nested", reason: "not-a-file" },
      { name: "link.yml", reason: "not-a-file" },
      { name: "module.yml", reason: "not-a-file" },
      { name: "folder.yml", reason: "not-a-file" },
      { name: "group.yml", reason: "not-a-file" },
      { name: "loose.yml", reason: "not-a-file" },
      { name: "bare.yml", reason: "not-a-file" },
      { name: "notes.md", reason: "not-yaml" },
      { name: "CI.YML", reason: "not-yaml" },
      { name: "ci.yml.bak", reason: "not-yaml" },
      { name: "f�.yml", reason: "invalid-name" },
    ]);
    expect(found.skippedCount).toBe(11);
  });

  it("keeps at most a bounded number of skipped entries, with names cut short", async () => {
    const long = "x".repeat(MAX_SKIPPED_NAME_BYTES + 100);
    const entries = Array.from({ length: MAX_SKIPPED_REPORTED + 5 }, (_, i) =>
      entry(`${long}${i}`),
    );
    const { tree } = fakeTree({ ".github/workflows": directory(...entries) });
    const found = await discoverWorkflows(tree);
    if (!found.ok) throw new Error("refused");
    expect(found.skipped).toHaveLength(MAX_SKIPPED_REPORTED);
    expect(found.skippedCount).toBe(MAX_SKIPPED_REPORTED + 5);
    for (const skipped of found.skipped) {
      expect(encoder.encode(skipped.name).length).toBeLessThanOrEqual(MAX_SKIPPED_NAME_BYTES);
    }
  });

  it("cuts a skipped name without splitting a character into invalid bytes", async () => {
    const name = `${"a".repeat(MAX_SKIPPED_NAME_BYTES - 1)}é.txt`;
    const { tree } = fakeTree({ ".github/workflows": directory(entry(name)) });
    const found = await discoverWorkflows(tree);
    if (!found.ok) throw new Error("refused");
    expect(found.skipped[0]?.name).toBe("a".repeat(MAX_SKIPPED_NAME_BYTES - 1));
  });

  it("refuses more workflow files than the bound rather than picking some", async () => {
    const entries = Array.from({ length: MAX_WORKFLOW_FILES + 1 }, (_, i) => entry(`w${i}.yml`));
    const { tree } = fakeTree({ ".github/workflows": directory(...entries) });
    expect(await discoverWorkflows(tree)).toEqual({
      ok: false,
      code: "too_many_workflows",
      directory: ".github/workflows",
    });
    const exactly = entries.slice(0, MAX_WORKFLOW_FILES);
    const found = await discoverWorkflows(
      fakeTree({ ".github/workflows": directory(...exactly) }).tree,
    );
    expect(found.ok && found.files).toHaveLength(MAX_WORKFLOW_FILES);
  });

  it("never mixes directories, and reads .github only when .fyrden is absent (property)", async () => {
    const listing = fc.oneof(
      fc.constant<DirectoryListing>(ABSENT),
      fc.constant<DirectoryListing>({ kind: "not-a-directory" }),
      fc.constant<DirectoryListing>({ kind: "too-large" }),
      fc
        .array(
          fc.record({
            name: fc.constantFrom("a.yml", "b.yaml", "c.txt", "d", "e.yml"),
            mode: fc.constantFrom(FILE, EXECUTABLE, SYMLINK, TREE, SUBMODULE),
          }),
          { maxLength: 6 },
        )
        .map((entries) => directory(...entries.map((e) => entry(e.name, e.mode)))),
    );
    await fc.assert(
      fc.asyncProperty(listing, listing, async (fyrden, github) => {
        const { tree, asked } = fakeTree({
          ".fyrden/workflows": fyrden,
          ".github/workflows": github,
        });
        const found = await discoverWorkflows(tree);
        const chosen: WorkflowDirectory =
          fyrden.kind === "absent" ? ".github/workflows" : ".fyrden/workflows";
        expect(asked).toEqual(
          fyrden.kind === "absent"
            ? [".fyrden/workflows", ".github/workflows"]
            : [".fyrden/workflows"],
        );
        const listed = chosen === ".fyrden/workflows" ? fyrden : github;
        if (found.ok) {
          expect(found.directory).toBe(listed.kind === "absent" ? null : chosen);
          for (const file of found.files) expect(file.path.startsWith(`${chosen}/`)).toBe(true);
        } else {
          expect(found.directory).toBe(chosen);
        }
      }),
    );
  });
});
