// A push whose pack unit is merged into a compacted pack at its commit (the
// pack-count cap): the compacted pack goes live, the merged live packs are
// superseded, and the upload's own unit is superseded instead of going live,
// all in the commit transaction.
import { type Oid, oidFromBytes, type PackId } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import type { RepoGitStorage } from "../../src/git/index.js";
import { inProbe, newProbe } from "./harness.js";

const oid = (n: number): Oid => oidFromBytes(new Uint8Array(20).fill(n));

/** An upload whose pack is written and indexed, with one pending commit row. */
async function indexedUpload(git: RepoGitStorage, n: number) {
  const upload = git.uploads.begin({
    networkId: git.networkId(),
    principal: "usr_A",
    grantId: "grant-1",
    tokenId: "tok-1",
    commands: [],
    atomic: true,
    withPack: true,
    ttlMs: 60_000,
    leaseTtlMs: 60_000,
  });
  git.uploads.markUploaded(upload.uploadId, { bytes: 3 });
  await git.commitGraph.insertPending(upload.uploadId, [
    {
      oid: oid(n),
      tree: oid(100 + n),
      parents: [],
      commitTime: 1000 + n,
      generation: 1000 + n,
      level: 1,
    },
  ]);
  git.uploads.markIndexed(upload.uploadId, { deps: [], objectCount: 1 });
  return upload;
}

/** A live pack, committed on its own. */
async function livePack(git: RepoGitStorage): Promise<PackId> {
  const writer = git.packStore.beginPack();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.finish();
  const result = git.refStore.commitSync({
    addPacks: [writer.packId],
    removePacks: [],
    refUpdates: [],
    expectedVersion: git.refStore.state().version,
  });
  if (!result.ok) throw new Error(`could not make a live pack: ${result.reason}`);
  return writer.packId;
}

const stateOf = (git: RepoGitStorage, packId: string | null) =>
  packId === null ? undefined : git.registry.get(packId)?.state;

describe("SqliteRefStore commit with a merged upload", () => {
  it("makes the merged pack live and supersedes the sources and the upload's unit, together", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const old = await livePack(git);
      const upload = await indexedUpload(git, 1);
      const merged = git.packStore.beginUploadPack("compact", upload.uploadId);
      await merged.write(new Uint8Array([9, 9]));
      await merged.finish();
      const commit = git.refStore.commitSync({
        addPacks: [merged.packId],
        removePacks: [old],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: git.refStore.state().version,
        uploadId: upload.uploadId,
        uploadUnitMergedInto: merged.packId,
      });
      return {
        commit,
        merged: stateOf(git, merged.packId),
        old: stateOf(git, old),
        received: stateOf(git, upload.packId),
        upload: git.uploads.get(upload.uploadId)?.state,
        live: (await git.packStore.listPacks()).map((p) => p.packId),
        mergedId: merged.packId,
        verified: (await git.commitGraph.read([oid(1)], "verified"))[0]?.state,
      };
    });
    expect(result.commit.ok).toBe(true);
    expect(result).toMatchObject({
      merged: "live",
      old: "superseded",
      received: "superseded",
      upload: "committed",
      verified: "verified",
    });
    expect(result.live).toEqual([result.mergedId]);
  });

  it("refuses a merge target that is not among the added packs, or without an upload", async () => {
    const { stub } = await newProbe();
    const errors = await inProbe(stub, async ({ git }) => {
      const upload = await indexedUpload(git, 2);
      const merged = git.packStore.beginUploadPack("compact", upload.uploadId);
      await merged.write(new Uint8Array([1]));
      await merged.finish();
      const attempt = (request: Partial<Parameters<typeof git.refStore.commitSync>[0]>) => {
        try {
          git.refStore.commitSync({
            addPacks: [],
            removePacks: [],
            refUpdates: [],
            expectedVersion: git.refStore.state().version,
            ...request,
          });
          return "committed";
        } catch (error) {
          return (error as Error).name;
        }
      };
      return {
        notAdded: attempt({ uploadId: upload.uploadId, uploadUnitMergedInto: merged.packId }),
        noUpload: attempt({ addPacks: [merged.packId], uploadUnitMergedInto: merged.packId }),
        received: stateOf(git, upload.packId),
        mergedState: stateOf(git, merged.packId),
      };
    });
    expect(errors).toEqual({
      notAdded: "RangeError",
      noUpload: "RangeError",
      received: "indexed",
      mergedState: "indexing",
    });
  });
});

describe("pack store and registry support for the pack-count cap", () => {
  it("an upload's compacted pack is discarded with the upload when the push ends without a commit", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const upload = await indexedUpload(git, 3);
      const merged = git.packStore.beginUploadPack("compact", upload.uploadId);
      await merged.write(new Uint8Array([1]));
      await merged.finish();
      const row = git.registry.get(merged.packId);
      const keys = git.uploads.abort(upload.uploadId) ?? [];
      return {
        row,
        keys,
        state: stateOf(git, merged.packId),
      };
    });
    expect(result.row).toMatchObject({ kind: "compact", unitId: null, state: "indexing" });
    expect(result.row?.uploadId).toBeTruthy();
    expect(result.keys).toContain(result.row?.r2Key);
    expect(result.state).toBe("discarded");
  });

  it("lists own live packs with their size, object count and creation time, oldest first", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const a = await livePack(git);
      const b = await livePack(git);
      const borrowed = await livePack(git);
      git.context.storage.sql.exec(
        "UPDATE packs SET origin = 'borrowed' WHERE pack_id = ?",
        borrowed,
      );
      git.context.storage.sql.exec("UPDATE packs SET object_count = 7 WHERE pack_id = ?", a);
      // Packs made in the same millisecond tie on created_at and then order by
      // their random pack ids, so give them distinct creation times.
      git.context.storage.sql.exec("UPDATE packs SET created_at = 1000 WHERE pack_id = ?", a);
      git.context.storage.sql.exec("UPDATE packs SET created_at = 2000 WHERE pack_id = ?", b);
      const pending = git.packStore.beginPack();
      return { a, b, pending: pending.packId, live: git.registry.liveOwn() };
    });
    expect(result.live.map((p) => p.packId)).toEqual([result.a, result.b]);
    expect(result.live[0]).toMatchObject({ bytes: 3, objectCount: 7, state: "live" });
    expect(result.live[1]?.objectCount).toBeNull();
    expect(typeof result.live[0]?.createdAt).toBe("number");
  });
});
