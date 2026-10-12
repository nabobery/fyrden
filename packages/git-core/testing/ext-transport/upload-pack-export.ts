import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addPendingCommits } from "../../src/graph/commit-graph.js";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { parsePack } from "../../src/pack/parse.js";
import type { CommitGraphRow, CommitInfo } from "../../src/ports/commit-graph.js";
import { createMemoryBudget } from "../fakes/memory-budget.js";
import { createMemoryCommitGraph } from "../fakes/memory-commit-graph.js";
import type { GitSandbox } from "../git-cli.js";
import { createNodeZlib } from "../node-zlib.js";
import { rowOf, type UploadPackRepoState, writeRepoState } from "./upload-pack-repo.js";

export interface ExportOptions {
  /**
   * The registry's `all_reachable` flag for each stored pack (by its index
   * in view order, newest first). Default: flagged when the refs reach
   * every object in the pack, as maintenance would compute it.
   */
  readonly allReachable?: (index: number) => boolean;
}

async function* chunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

/**
 * Stores the packs of a sandbox repository the way the receive path keeps
 * them (the bytes git wrote, an `.idx` written by the engine) together with
 * its refs and commit graph rows, in an upload-pack repository directory.
 * Loose objects are packed first (`git repack -d`, which adds one pack and
 * keeps the others), so every object is in a pack. Objects only the reflog
 * keeps stay in the packs and the commit graph, as they do on the server.
 */
export async function exportUploadPackRepo(
  sandbox: GitSandbox,
  dir: string,
  options: ExportOptions = {},
): Promise<UploadPackRepoState> {
  await sandbox.git(["repack", "-d", "-q"]);
  const packDir = join(sandbox.dir, ".git/objects/pack");
  const names = (await readdir(packDir)).filter((name) => name.endsWith(".pack"));
  const dated = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(packDir, name))).mtimeMs })),
  );
  dated.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));

  await mkdir(join(dir, "packs"), { recursive: true });
  const reachable = await reachableObjects(sandbox);
  const zlib = createNodeZlib();
  const packs: { name: string; allReachable: boolean }[] = [];
  for (const [index, { name }] of dated.entries()) {
    const bytes = new Uint8Array(await readFile(join(packDir, name)));
    const parsed = await parsePack(chunks(bytes, 64 * 1024), {
      zlib,
      memory: createMemoryBudget(1024 * 1024 * 1024),
      readRange: async (offset, length) => bytes.subarray(offset, offset + length),
    });
    const idx = await writeIdx(parsed.entries, parsed.checksum, {
      createHasher: () => createSha1Hasher({ detectCollisions: false }),
    });
    parsed.release();
    const stored = `p${index}`;
    await writeFile(join(dir, "packs", `${stored}.pack`), bytes);
    await writeFile(join(dir, "packs", `${stored}.idx`), idx.bytes);
    const parsedIdx = PackIdx.parse(idx.bytes);
    const flagged = [...parsedIdx.entries()].every((e) => reachable.has(oidToHex(e.oid)));
    packs.push({ name: stored, allReachable: options.allReachable?.(index) ?? flagged });
  }

  const { stdout: refText } = await sandbox.git([
    "for-each-ref",
    "--format=%(objectname) %(refname)",
  ]);
  const refs = refText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hex, name] = line.split(" ") as [string, string];
      return [name, hex] as const;
    });
  const { stdout: headText } = await sandbox.git(["symbolic-ref", "-q", "HEAD"], {
    okExitCodes: [0, 1],
  });
  const head = headText.trim() || null;

  const commits = await commitInfos(sandbox);
  const graph = createMemoryCommitGraph();
  await addPendingCommits(graph, "export", commits);
  const rows = await graph.read(
    commits.map((c) => c.oid),
    { uploadId: "export" },
  );
  const state: UploadPackRepoState = {
    head,
    refs,
    packs,
    commits: rows.map((row) => rowOf(row as CommitGraphRow)),
  };
  await writeRepoState(dir, state);
  return state;
}

/** `git rev-list --objects --all`: what the refs reach (the reflog is not a ref). */
async function reachableObjects(sandbox: GitSandbox): Promise<Set<string>> {
  const { stdout } = await sandbox.git(["rev-list", "--objects", "--all"]);
  return new Set(
    stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(0, 40)),
  );
}

/** Every commit in the repository's object store (reflog-only ones included), as git reads them. */
async function commitInfos(sandbox: GitSandbox): Promise<CommitInfo[]> {
  const { stdout: all } = await sandbox.git([
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype)",
  ]);
  const oids = all
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, type]) => type === "commit")
    .map(([oid]) => oid as string);
  if (oids.length === 0) return [];
  const { stdout } = await sandbox.git(
    ["log", "--no-walk=unsorted", "--stdin", "--format=%H %T %ct %P"],
    { input: `${oids.join("\n")}\n` },
  );
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [oid, tree, time, ...parents] = line.trim().split(" ") as [string, string, string];
      return {
        oid: oidFromHex(oid),
        tree: oidFromHex(tree),
        parents: (parents as string[]).filter((p) => p.length > 0).map(oidFromHex),
        commitTime: Number(time),
      };
    });
}
