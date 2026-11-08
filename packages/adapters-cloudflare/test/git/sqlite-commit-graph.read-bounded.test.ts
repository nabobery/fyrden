// A point read of one verified commit for blame: its parents only within a
// limit, so a commit with thousands of parents costs one small row, not
// the whole column copied twice before anyone can count it.
import { addPendingCommits, type Oid, oidFromBytes } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import type { RepoGitStorage } from "../../src/git/index.js";
import { SqliteCommitGraph } from "../../src/git/index.js";
import type { GitStorageContext } from "../../src/git/sql.js";
import { inProbe, newProbe } from "./harness.js";

const oid = (n: number): Oid => oidFromBytes(new Uint8Array(20).fill(n));
const commit = (n: number, parents: number[]) => ({
  oid: oid(n),
  tree: oid(100 + n),
  parents: parents.map(oid),
  commitTime: 1_000 + n,
});
const range = (from: number, count: number) => Array.from({ length: count }, (_, k) => from + k);

/** Promotes `commits` to verified, as a push's commit transaction does. */
async function verified(git: RepoGitStorage, commits: ReturnType<typeof commit>[]) {
  const upload = git.uploads.begin({
    networkId: git.networkId(),
    principal: "usr_seed",
    commands: [],
    atomic: true,
    withPack: true,
    ttlMs: 60_000,
    leaseTtlMs: 60_000,
  });
  git.uploads.markUploaded(upload.uploadId, { bytes: 1 });
  await addPendingCommits(git.commitGraph, upload.uploadId, commits);
  git.uploads.markIndexed(upload.uploadId, { deps: [] });
  const result = git.refStore.commitSync({
    addPacks: [],
    removePacks: [],
    refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: commits.at(-1)?.oid as Oid }],
    expectedVersion: git.refStore.readRefsSync().version,
    uploadId: upload.uploadId,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** The graph over the same storage, keeping every row SQLite handed back. */
function spied(context: GitStorageContext) {
  const returned: Record<string, unknown>[] = [];
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const cursor = context.storage.sql.exec(query, ...bindings);
      return {
        toArray: () => {
          const out = cursor.toArray();
          returned.push(...out);
          return out;
        },
      };
    },
  };
  const storage = { ...context.storage, sql } as unknown as GitStorageContext["storage"];
  return { graph: new SqliteCommitGraph({ ...context, storage }), returned };
}

describe("SqliteCommitGraph.readBounded", () => {
  it("reads a verified commit with its parents up to the limit, and none past it", async () => {
    const { stub } = await newProbe();
    const seen = await inProbe(stub, async ({ git }) => {
      await verified(git, [
        ...range(10, 17).map((n) => commit(n, [])),
        commit(2, range(10, 16)),
        commit(3, range(10, 17)),
      ]);
      const [full, fullMany] = git.commitGraph.readSync([oid(2), oid(3)], "verified");
      const sixteen = git.commitGraph.readBounded(oid(2), 16);
      const { graph, returned } = spied(git.context);
      const tooMany = graph.readBounded(oid(3), 16);
      return {
        sixteen,
        expected: full && {
          tree: full.tree,
          parents: full.parents,
          generation: full.generation,
          level: full.level,
        },
        tooMany,
        expectedMany: fullMany && {
          tree: fullMany.tree,
          parents: "too_many",
          generation: fullMany.generation,
          level: fullMany.level,
        },
        parentsHandedBack: returned.map((row) => row.parents ?? null),
        seventeenAtSeventeen: git.commitGraph.readBounded(oid(3), 17),
      };
    });
    expect(seen.sixteen).toEqual(seen.expected);
    expect(seen.tooMany).toEqual(seen.expectedMany);
    expect(seen.parentsHandedBack).toEqual([null]);
    expect(seen.seventeenAtSeventeen?.parents).toHaveLength(17);
  });

  it("knows only verified commits: an unknown or still pending one is undefined", async () => {
    const { stub } = await newProbe();
    const seen = await inProbe(stub, async ({ git }) => {
      await verified(git, [commit(1, [])]);
      const upload = git.uploads.begin({
        networkId: git.networkId(),
        principal: "usr_a",
        commands: [],
        atomic: true,
        withPack: true,
        ttlMs: 60_000,
        leaseTtlMs: 60_000,
      });
      git.uploads.markUploaded(upload.uploadId, { bytes: 1 });
      await addPendingCommits(git.commitGraph, upload.uploadId, [commit(2, [1])]);
      return {
        root: git.commitGraph.readBounded(oid(1), 16),
        pending: git.commitGraph.readBounded(oid(2), 16),
        unknown: git.commitGraph.readBounded(oid(9), 16),
      };
    });
    expect(seen.root).toMatchObject({ parents: [], tree: oid(101) });
    expect(seen.pending).toBeUndefined();
    expect(seen.unknown).toBeUndefined();
  });
});
