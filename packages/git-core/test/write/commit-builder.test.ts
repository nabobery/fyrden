import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { type Oid, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { parseTree, type TreeEntry } from "../../src/object/tree.js";
import { buildCommit, CommitBuildError, type FileChange } from "../../src/write/commit-builder.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

/*
 * Differential tests against git: a base tree built with git, random sets of
 * file writes and deletions applied by buildCommit, and the same changes
 * applied by git to a temporary index (`update-index`, `write-tree`). The
 * trees must be the same object; so must the commits (`commit-tree` with the
 * same people, dates and message). A change git refuses must be refused.
 */

const SEED = 20261014;
const createHasher = () => createSha1Hasher({ detectCollisions: false });
const encoder = new TextEncoder();

let sandbox: GitSandbox;
let dir: string;
let baseTree: string;
let baseCommit: string;
const trees = new Map<string, TreeEntry[]>();

/** Base files: a regular file, nested ones, an executable and a symlink. */
const BASE: Record<string, { content: string; mode?: string }> = {
  "a.txt": { content: "a\n" },
  "d/x.txt": { content: "x\n" },
  "d/e/y.txt": { content: "y\n" },
  "run.sh": { content: "#!/bin/sh\n", mode: "100755" },
  link: { content: "a.txt", mode: "120000" },
};
/** Paths a change may name: existing ones, new ones, and ones through files. */
const PATHS = [
  "a.txt",
  "d/x.txt",
  "d/e/y.txt",
  "run.sh",
  "link",
  "b.txt",
  "d/new.txt",
  "n/m/o.txt",
  "a.txt/z",
  "d",
  "d/e",
];

beforeAll(async () => {
  sandbox = await createGitSandbox();
  dir = join(sandbox.dir, "repo");
  await sandbox.git(["init", "-q", "-b", "main", dir]);
  for (const [path, { content, mode }] of Object.entries(BASE)) {
    const { stdout } = await sandbox.git(["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: content,
    });
    await sandbox.git(
      ["update-index", "--add", "--cacheinfo", `${mode ?? "100644"},${stdout.trim()},${path}`],
      { cwd: dir },
    );
  }
  baseTree = (await sandbox.git(["write-tree"], { cwd: dir })).stdout.trim();
  baseCommit = (
    await sandbox.git(["commit-tree", baseTree, "-m", "base"], { cwd: dir, env: people(0) })
  ).stdout.trim();
});
afterAll(() => sandbox.dispose());

function people(time: number) {
  return {
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@fyrden.invalid",
    GIT_AUTHOR_DATE: `@${1_700_000_000 + time} +0200`,
    GIT_COMMITTER_NAME: "Fyrden",
    GIT_COMMITTER_EMAIL: "noreply@fyrden.invalid",
    GIT_COMMITTER_DATE: `@${1_700_000_000 + time} +0000`,
  };
}

/** Reads (and caches) a tree of the sandbox repository. */
async function readTree(oid: Oid): Promise<readonly TreeEntry[]> {
  const hex = oidToHex(oid);
  let entries = trees.get(hex);
  if (!entries) {
    const body = await sandbox.gitBytes(["cat-file", "tree", hex], { cwd: dir });
    entries = parseTree(body).value;
    trees.set(hex, entries);
  }
  return entries;
}

type Change =
  | { path: string; content: string; mode?: "file" | "executable" }
  | { path: string; delete: true };

/** What git makes of the changes in a fresh index over the base tree, or "refused". */
async function gitTree(changes: readonly Change[]): Promise<string | "refused"> {
  const env = { GIT_INDEX_FILE: join(sandbox.dir, `index-${Math.random()}`) };
  await sandbox.git(["read-tree", baseTree], { cwd: dir, env });
  const ls = (await sandbox.git(["ls-files", "-s"], { cwd: dir, env })).stdout;
  const modes = new Map(
    ls
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        return [path as string, (meta as string).split(" ")[0] as string];
      }),
  );
  for (const change of changes) {
    if ("delete" in change) {
      if (!modes.has(change.path)) return "refused";
      await sandbox.git(["update-index", "--force-remove", change.path], { cwd: dir, env });
      continue;
    }
    const { stdout } = await sandbox.git(["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: change.content,
    });
    const existing = modes.get(change.path);
    const mode =
      change.mode === "executable" || (!change.mode && existing === "100755") ? "100755" : "100644";
    const result = await sandbox
      .git(["update-index", "--add", "--cacheinfo", `${mode},${stdout.trim()},${change.path}`], {
        cwd: dir,
        env,
      })
      .then(
        () => "ok",
        () => "refused",
      );
    if (result === "refused") return "refused";
  }
  return (await sandbox.git(["write-tree"], { cwd: dir, env })).stdout.trim();
}

const toFileChange = (change: Change): FileChange =>
  "delete" in change
    ? { path: change.path.split("/").map((p) => encoder.encode(p)), delete: true }
    : {
        path: change.path.split("/").map((p) => encoder.encode(p)),
        content: encoder.encode(change.content),
        ...(change.mode && { mode: change.mode }),
      };

const ident = (name: string, email: string, time: number, timezone: string) => ({
  name: encoder.encode(name),
  email: encoder.encode(email),
  timestamp: 1_700_000_000 + time,
  timezone,
});

async function build(changes: readonly Change[], time = 1) {
  return buildCommit({
    baseTree: oidFromHex(baseTree),
    readTree,
    changes: changes.map(toFileChange),
    parents: [oidFromHex(baseCommit)],
    author: ident("Ada", "ada@fyrden.invalid", time, "+0200"),
    committer: ident("Fyrden", "noreply@fyrden.invalid", time, "+0000"),
    message: encoder.encode("change\n"),
    createHasher,
  });
}

const changeArb: fc.Arbitrary<Change> = fc.oneof(
  fc
    .record({
      path: fc.constantFrom(...PATHS),
      content: fc.constantFrom("a\n", "new\n", "x\n", ""),
      mode: fc.constantFrom(undefined, "file" as const, "executable" as const),
    })
    .map(({ path, content, mode }) => (mode ? { path, content, mode } : { path, content })),
  fc.constantFrom(...PATHS).map((path) => ({ path, delete: true as const })),
);

describe("buildCommit", () => {
  it("makes the tree git makes for the same changes, and refuses what git refuses", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(changeArb, { minLength: 1, maxLength: 4 }), async (changes) => {
        // One change per path, none inside another (the builder refuses those itself).
        const paths = changes.map((c) => c.path);
        const nested = paths.some((p, i) =>
          paths.some((q, j) => i !== j && (p === q || q.startsWith(`${p}/`))),
        );
        const expected = await gitTree(changes);
        let ours: string | "refused" | "no_change";
        try {
          ours = oidToHex((await build(changes)).tree);
        } catch (error) {
          if (!(error instanceof CommitBuildError)) throw error;
          if (error.code === "path_conflict") {
            expect(nested).toBe(true);
            return;
          }
          ours = error.code === "no_change" ? "no_change" : "refused";
        }
        if (nested) return;
        if (ours === "no_change") expect(expected).toBe(baseTree);
        else expect(ours).toBe(expected);
      }),
      { seed: SEED, numRuns: 60 },
    );
  }, 120_000);

  it("makes the commit git's commit-tree makes, and lists every new object once", async () => {
    const changes: Change[] = [
      { path: "n/m/o.txt", content: "deep\n" },
      { path: "a.txt", delete: true },
      { path: "run.sh", content: "#!/bin/sh\necho\n" },
    ];
    const built = await build(changes, 5);
    const tree = oidToHex(built.tree);
    expect(tree).toBe(await gitTree(changes));
    const commit = (
      await sandbox.git(["commit-tree", tree, "-p", baseCommit, "-m", "change"], {
        cwd: dir,
        env: people(5),
      })
    ).stdout.trim();
    expect(oidToHex(built.commit)).toBe(commit);
    const hexes = built.objects.map((o) => oidToHex(o.oid));
    expect(new Set(hexes).size).toBe(hexes.length);
    expect(hexes).toContain(commit);
    expect(built.blobs.map((b) => (b ? oidToHex(b) : null))[1]).toBeNull();
  });

  it("rewrites a legacy file mode in a rebuilt tree as git's index does", async () => {
    // A tree holding `old.txt` as 100664 (git still reads such trees).
    const blob = (
      await sandbox.git(["hash-object", "-w", "--stdin"], { cwd: dir, input: "old\n" })
    ).stdout.trim();
    const raw = new Uint8Array([...encoder.encode("100664 old.txt\0"), ...oidFromHex(blob)]);
    const legacy = (
      await sandbox.git(["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], {
        cwd: dir,
        input: raw,
      })
    ).stdout.trim();
    const built = await buildCommit({
      baseTree: oidFromHex(legacy),
      readTree,
      changes: [toFileChange({ path: "new.txt", content: "new\n" })],
      parents: [],
      author: ident("Ada", "ada@fyrden.invalid", 1, "+0000"),
      committer: ident("Ada", "ada@fyrden.invalid", 1, "+0000"),
      message: encoder.encode("x\n"),
      createHasher,
    });
    // What git makes of the same tree through its index.
    const env = { GIT_INDEX_FILE: join(sandbox.dir, `index-legacy`) };
    await sandbox.git(["read-tree", legacy], { cwd: dir, env });
    const added = (
      await sandbox.git(["hash-object", "-w", "--stdin"], { cwd: dir, input: "new\n" })
    ).stdout.trim();
    await sandbox.git(["update-index", "--add", "--cacheinfo", `100644,${added},new.txt`], {
      cwd: dir,
      env,
    });
    const expected = (await sandbox.git(["write-tree"], { cwd: dir, env })).stdout.trim();
    expect(oidToHex(built.tree)).toBe(expected);
  });

  it("refuses a change that would change nothing, and names git would not store", async () => {
    await expect(build([{ path: "a.txt", content: "a\n" }])).rejects.toMatchObject({
      code: "no_change",
    });
    for (const bad of [".git/config", "d/../x", "./a", "a//b"])
      await expect(build([{ path: bad, content: "x" }])).rejects.toThrow(RangeError);
  });

  it("signs the commit with the signer, over the unsigned commit", async () => {
    let signed: Uint8Array | undefined;
    const built = await buildCommit({
      baseTree: oidFromHex(baseTree),
      readTree,
      changes: [toFileChange({ path: "b.txt", content: "b\n" })],
      parents: [oidFromHex(baseCommit)],
      author: ident("Ada", "ada@fyrden.invalid", 1, "+0000"),
      committer: ident("Ada", "ada@fyrden.invalid", 1, "+0000"),
      message: encoder.encode("signed\n"),
      createHasher,
      signer: {
        async sign(payload) {
          signed = payload;
          return encoder.encode("-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----");
        },
      },
    });
    const commit = built.objects.find((o) => o.type === "commit");
    const text = new TextDecoder().decode(commit?.data);
    expect(text).toContain(
      "gpgsig -----BEGIN SSH SIGNATURE-----\n AAAA\n -----END SSH SIGNATURE-----\n",
    );
    expect(new TextDecoder().decode(signed)).not.toContain("gpgsig");
    // git accepts the object and reads the signature header back.
    const { stdout } = await sandbox.git(["hash-object", "-t", "commit", "--stdin", "-w"], {
      cwd: dir,
      input: commit?.data as Uint8Array,
    });
    expect(stdout.trim()).toBe(oidToHex(built.commit));
  });
});
