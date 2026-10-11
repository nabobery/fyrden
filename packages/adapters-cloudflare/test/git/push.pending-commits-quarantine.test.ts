// Storage half of the pending-commit quarantine: rows an upload writes stay
// pending and visible to that upload only, until its commit transaction
// promotes them. Push A (commit C, whose closure the connectivity check will
// find broken) is rejected; nothing of C is ever visible to the verified
// view, to merge-base, or to another upload, and its rows go when it aborts.
import {
  addPendingCommits,
  isAncestor,
  MissingCommitError,
  mergeBases,
  type Oid,
  oidFromBytes,
} from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import type { RepoGitStorage } from "../../src/git/index.js";
import { inProbe, newProbe } from "./harness.js";

const oid = (n: number): Oid => oidFromBytes(new Uint8Array(20).fill(n));
const commit = (n: number, parents: number[]) => ({
  oid: oid(n),
  tree: oid(100 + n),
  parents: parents.map(oid),
  commitTime: 1_000 + n,
});

function begin(git: RepoGitStorage, principal: string) {
  const upload = git.uploads.begin({
    networkId: git.networkId(),
    principal,
    commands: [],
    atomic: true,
    withPack: true,
    ttlMs: 60_000,
    leaseTtlMs: 60_000,
  });
  git.uploads.markUploaded(upload.uploadId, { bytes: 1 });
  return upload;
}

async function caught(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "no error";
  } catch (error) {
    return error instanceof MissingCommitError ? "MissingCommitError" : String(error);
  }
}

describe("pending commit quarantine (storage)", () => {
  it("never shows an upload's pending commits to anyone else, and discards them on abort", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const graph = git.commitGraph;
      // Verified history: R, committed by an earlier push.
      const seed = begin(git, "usr_seed");
      await addPendingCommits(graph, seed.uploadId, [commit(1, [])]);
      git.uploads.markIndexed(seed.uploadId, { deps: [] });
      git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
        uploadId: seed.uploadId,
      });

      // Push A writes C (child of R) as pending.
      const a = begin(git, "usr_a");
      await addPendingCommits(graph, a.uploadId, [commit(2, [1])]);
      const b = begin(git, "usr_b");

      const seen = {
        verifiedRead: (await graph.read([oid(2)], "verified"))[0],
        otherUploadRead: (await graph.read([oid(2)], { uploadId: b.uploadId }))[0],
        ownRead: (await graph.read([oid(2)], { uploadId: a.uploadId }))[0]?.state,
        mergeBaseVerified: await caught(() => mergeBases(graph, "verified", oid(2), [oid(1)])),
        ancestorVerified: await caught(() => isAncestor(graph, "verified", oid(1), oid(2))),
        mergeBaseOtherUpload: await caught(() =>
          mergeBases(graph, { uploadId: b.uploadId }, oid(2), [oid(1)]),
        ),
        // Push B builds on C: its parent is not visible to B.
        childInOtherUpload: await caught(() =>
          addPendingCommits(graph, b.uploadId, [commit(3, [2])]),
        ),
        ownMergeBase: (await mergeBases(graph, { uploadId: a.uploadId }, oid(2), [oid(1)])).map(
          (o) => o[0],
        ),
      };

      // A is rejected (its connectivity check failed): everything it wrote goes.
      const keys = git.uploads.abort(a.uploadId);
      const afterAbort = {
        ownRead: (await graph.read([oid(2)], { uploadId: a.uploadId }))[0],
        pendingRows: git.context.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM pending_commits WHERE upload_id = ?",
            a.uploadId,
          )
          .one().n,
        pack: git.registry.get(a.packId as string)?.state,
        upload: git.uploads.get(a.uploadId)?.state,
        keys: keys?.length,
        // An aborted upload can never commit.
        commit: git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: "refs/heads/main", oldOid: oid(1), newOid: oid(2) }],
          expectedVersion: 1,
          uploadId: a.uploadId,
        }),
      };
      return { seen, afterAbort, uploadA: a.uploadId };
    });

    expect(result.seen).toEqual({
      verifiedRead: undefined,
      otherUploadRead: undefined,
      ownRead: "pending",
      mergeBaseVerified: "MissingCommitError",
      ancestorVerified: "MissingCommitError",
      mergeBaseOtherUpload: "MissingCommitError",
      childInOtherUpload: "MissingCommitError",
      ownMergeBase: [1],
    });
    expect(result.afterAbort).toEqual({
      ownRead: undefined,
      pendingRows: 0,
      pack: "discarded",
      upload: "rejected",
      keys: 1,
      commit: {
        ok: false,
        reason: "upload-not-ready",
        uploadId: result.uploadA,
        state: "rejected",
      },
    });
  });

  it("promotes pending rows only inside the commit transaction", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const a = begin(git, "usr_a");
      await addPendingCommits(git.commitGraph, a.uploadId, [commit(1, []), commit(2, [1])]);
      git.uploads.markIndexed(a.uploadId, { deps: [] });
      const before = await git.commitGraph.read([oid(2)], "verified");
      // A refused commit (here by the re-authorization hook) promotes nothing.
      const refused = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(2) }],
        expectedVersion: 0,
        uploadId: a.uploadId,
        authorize: () => "grant revoked",
      });
      const afterRefusal = await git.commitGraph.read([oid(2)], "verified");
      const committed = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(2) }],
        expectedVersion: 0,
        uploadId: a.uploadId,
      });
      return {
        before: before[0],
        refused: refused.ok,
        afterRefusal: afterRefusal[0],
        committed,
        after: (await git.commitGraph.read([oid(1), oid(2)], "verified")).map((e) => e?.state),
        bases: (await mergeBases(git.commitGraph, "verified", oid(2), [oid(1)])).map((o) => o[0]),
      };
    });
    expect(result).toEqual({
      before: undefined,
      refused: false,
      afterRefusal: undefined,
      committed: { ok: true, version: 1 },
      after: ["verified", "verified"],
      bases: [1],
    });
  });
});
