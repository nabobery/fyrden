import { type Oid, oidFromBytes } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import type { RepoGitStorage } from "../../src/git/index.js";
import { inProbe, newProbe } from "./harness.js";

const oid = (n: number): Oid => oidFromBytes(new Uint8Array(20).fill(n));
const row = (n: number, parents: number[]) => ({
  oid: oid(n),
  tree: oid(100 + n),
  parents: parents.map(oid),
  commitTime: 1000 + n,
  generation: 1000 + n,
  level: n,
});

/** An upload whose pack is written and indexed, with pending commit rows. */
async function indexedUpload(git: RepoGitStorage, commits: number[][]) {
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
  await git.commitGraph.insertPending(
    upload.uploadId,
    commits.map(([n, ...parents]) => row(n as number, parents)),
  );
  git.uploads.markIndexed(upload.uploadId, { deps: [], objectCount: commits.length });
  return upload;
}

describe("SqliteRefStore commit with an upload", () => {
  it("adds the pack, promotes pending commits, releases leases and records the actor, together", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const upload = await indexedUpload(git, [[1], [2, 1]]);
      const leasedBefore = git.leases.leased([upload.packId as never]).size;
      const commit = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(2) }],
        expectedVersion: 0,
        uploadId: upload.uploadId,
        actor: { principal: "usr_A", grantId: "grant-1", tokenId: "tok-1", via: "push" },
      });
      const reflog = git.context.storage.sql
        .exec("SELECT actor, grant_id, token_id, via, upload_id FROM reflog")
        .toArray();
      return {
        commit,
        leasedBefore,
        leasedAfter: git.leases.leased([upload.packId as never]).size,
        live: await git.packStore.listPacks(),
        packId: upload.packId,
        verified: await git.commitGraph.read([oid(1), oid(2)], "verified"),
        upload: git.uploads.get(upload.uploadId)?.state,
        pending: git.context.storage.sql.exec("SELECT count(*) AS n FROM pending_commits").one().n,
        reflog,
        uploadId: upload.uploadId,
      };
    });
    expect(result.commit).toEqual({ ok: true, version: 1 });
    expect(result.live).toEqual([{ packId: result.packId, bytes: 3 }]);
    expect(result.verified.map((e) => e?.state)).toEqual(["verified", "verified"]);
    expect(result.pending).toBe(0);
    expect(result.upload).toBe("committed");
    expect([result.leasedBefore, result.leasedAfter]).toEqual([1, 0]);
    expect(result.reflog).toEqual([
      {
        actor: "usr_A",
        grant_id: "grant-1",
        token_id: "tok-1",
        via: "push",
        upload_id: result.uploadId,
      },
    ]);
  });

  it("refuses an upload that is not indexed, leaving its rows pending", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const upload = git.uploads.begin({
        networkId: git.networkId(),
        principal: "usr_A",
        commands: [],
        atomic: false,
        withPack: true,
        ttlMs: 60_000,
        leaseTtlMs: 60_000,
      });
      await git.commitGraph.insertPending(upload.uploadId, [row(1, [])]);
      const commit = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
        uploadId: upload.uploadId,
      });
      return {
        commit,
        uploadId: upload.uploadId,
        pending: await git.commitGraph.read([oid(1)], { uploadId: upload.uploadId }),
        version: git.refStore.state().version,
      };
    });
    expect(result.commit).toEqual({
      ok: false,
      reason: "upload-not-ready",
      uploadId: result.uploadId,
      state: "open",
    });
    expect(result.pending[0]?.state).toBe("pending");
    expect(result.version).toBe(0);
  });

  it("refuses when a dependency is gone and rescues one that became garbage", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const base = git.packStore.beginPack();
      await base.write(new Uint8Array([1]));
      await base.finish();
      git.refStore.commitSync({
        addPacks: [base.packId],
        removePacks: [],
        refUpdates: [],
        expectedVersion: 0,
      });
      const upload = await indexedUpload(git, [[1]]);
      git.context.storage.sql.exec(
        "UPDATE uploads SET deps = ? WHERE upload_id = ?",
        JSON.stringify([base.packId]),
        upload.uploadId,
      );
      const request = {
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 1,
        uploadId: upload.uploadId,
      };
      git.registry.transition(base.packId, ["live"], "condemned");
      const gone = git.refStore.commitSync(request);
      git.context.storage.sql.exec(
        "UPDATE packs SET state = 'garbage' WHERE pack_id = ?",
        base.packId,
      );
      const rescued = git.refStore.commitSync(request);
      return {
        gone,
        rescued,
        baseState: git.registry.get(base.packId)?.state,
        baseId: base.packId,
      };
    });
    expect(result.gone).toEqual({ ok: false, reason: "dependency-gone", packId: result.baseId });
    expect(result.rescued).toEqual({ ok: true, version: 2 });
    expect(result.baseState).toBe("live");
  });
});

describe("SqliteRefStore commit hooks", () => {
  it("writes nothing when authorize refuses, and runs it inside the transaction", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, ({ git }) => {
      let seenVersion = -1;
      const refused = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
        authorize: (context) => {
          seenVersion = context.version;
          return "token revoked";
        },
      });
      return { refused, seenVersion, refs: git.refStore.readRefsSync() };
    });
    expect(result.refused).toEqual({ ok: false, reason: "refused", message: "token revoked" });
    expect(result.seenVersion).toBe(1);
    expect(result.refs.version).toBe(0);
    expect(result.refs.refs.size).toBe(0);
  });

  it("rolls everything back when onCommitted throws", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, ({ git }) => {
      let threw = false;
      try {
        git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
          expectedVersion: 0,
          onCommitted: () => {
            throw new Error("outbox full");
          },
        });
      } catch {
        threw = true;
      }
      const reflog = git.context.storage.sql.exec("SELECT count(*) AS n FROM reflog").one().n;
      return { threw, refs: git.refStore.readRefsSync(), reflog };
    });
    expect(result.threw).toBe(true);
    expect(result.refs.version).toBe(0);
    expect(result.refs.refs.size).toBe(0);
    expect(result.reflog).toBe(0);
  });
});

describe("SqliteRefStore inCommit", () => {
  it("runs inside every commit after the request's own hook, and rolls back when it throws", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, ({ git }) => {
      const order: string[] = [];
      const commit = (n: number, old: Oid | null) =>
        git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: "refs/heads/main", oldOid: old, newOid: oid(n) }],
          expectedVersion: n - 1,
          onCommitted: () => order.push("request"),
        });
      git.refStore.inCommit = ({ version }) => {
        order.push(`owner ${version}`);
        if (version === 2) throw new Error("outbox full");
      };
      const first = commit(1, null);
      let threw = false;
      try {
        commit(2, oid(1));
      } catch {
        threw = true;
      }
      git.refStore.inCommit = undefined;
      return { first, threw, order, version: git.refStore.readRefsSync().version };
    });
    expect(result.first).toEqual({ ok: true, version: 1 });
    expect(result.threw).toBe(true);
    expect(result.order).toEqual(["request", "owner 1", "request", "owner 2"]);
    expect(result.version).toBe(1);
  });
});

describe("SqliteRefStore bookkeeping", () => {
  it("bumps nonff_version for deletions and unproven updates only", async () => {
    const { stub } = await newProbe();
    const versions = await inProbe(stub, ({ git }) => {
      const step = (update: { oldOid: Oid | null; newOid: Oid | null }, ff = false) => {
        const { version } = git.refStore.state();
        git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: "refs/heads/main", ...update }],
          expectedVersion: version,
          ...(ff ? { fastForward: new Set(["refs/heads/main"]) } : {}),
        });
        return git.refStore.state().nonffVersion;
      };
      return [
        step({ oldOid: null, newOid: oid(1) }),
        step({ oldOid: oid(1), newOid: oid(2) }, true),
        step({ oldOid: oid(2), newOid: oid(3) }),
        step({ oldOid: oid(3), newOid: null }),
      ];
    });
    expect(versions).toEqual([0, 0, 1, 2]);
  });

  it("points HEAD at the default branch and refuses to move HEAD as a ref", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, ({ git }) => git.refStore.readRefsSync());
    expect(result.head).toBe("refs/heads/main");
    await expect(
      inProbe(stub, ({ git }) =>
        git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: "HEAD", oldOid: null, newOid: oid(1) }],
          expectedVersion: 0,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });

  it("requires a pack unit to be added and removed whole", async () => {
    const { stub } = await newProbe();
    await expect(
      inProbe(stub, async ({ git }) => {
        const unit = "unit-1";
        const ids = [];
        for (let i = 0; i < 2; i++) {
          const writer = git.packStore.beginPack();
          await writer.write(new Uint8Array([i]));
          await writer.finish();
          git.context.storage.sql.exec(
            "UPDATE packs SET unit_id = ? WHERE pack_id = ?",
            unit,
            writer.packId,
          );
          ids.push(writer.packId);
        }
        return git.refStore.commitSync({
          addPacks: [ids[0] as never],
          removePacks: [],
          refUpdates: [],
          expectedVersion: 0,
        });
      }),
    ).rejects.toThrow(/pack unit/);
  });

  it("counts rows written for the commit", async () => {
    const { stub } = await newProbe();
    const counted = await inProbe(stub, (probe) => {
      probe.git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
      });
      return probe.metrics.filter(
        (m) => m.name === "do.rows_written" && m.dimensions.op === "refs.commit",
      );
    });
    expect(counted).toHaveLength(1);
    expect(counted[0]?.dimensions.class).toBe("RepoDO");
    expect(counted[0]?.value).toBeGreaterThanOrEqual(3);
  });
});
