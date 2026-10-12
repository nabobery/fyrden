import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  enqueueReflogPrune,
  LOCK_REF_COMMIT,
  REFLOG_PRUNE_JOB_ID,
  REFLOG_RETENTION_MS,
} from "@fyrden/adapters-cloudflare/git";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { advance, setOffset } from "./helpers/maintenance.js";
import { indexedUpload, inRepo, newRepo, oid } from "./helpers/repo-git.js";

const main = "refs/heads/main";
/** The dead holder's lock TTL: far longer than the test, which moves the clock past it. */
const DEAD_LOCK_TTL = 10 * 60_000;

describe("RepoDO git storage", () => {
  it("initializes with a valid network id only", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    expect(await stub.initGitStorage("net_../../etc")).toEqual({
      ok: false,
      error: "not a network id",
    });
    const { stub: ready, networkId } = await newRepo();
    const state = await inRepo(ready, ({ git }) => ({
      network: git.networkId(),
      head: git.refStore.readRefsSync().head,
    }));
    expect(state).toEqual({ network: networkId, head: main });
  });

  it("leaves no partial state when evicted between lock and commit; the lock then expires", async () => {
    const { stub } = await newRepo();
    const upload = await inRepo(stub, async ({ git }) => {
      const upload = await indexedUpload(git, git.bucket, "usr_a", [[1]]);
      // The holder dies here, after taking the lock and before its commit.
      git.locks.tryAcquire(LOCK_REF_COMMIT, "push-a", DEAD_LOCK_TTL);
      return upload;
    });
    await evictDurableObject(stub);
    const after = await inRepo(stub, async ({ git }) => ({
      refs: git.refStore.readRefsSync(),
      live: await git.packStore.listPacks(),
      verified: await git.commitGraph.read([oid(1)], "verified"),
      pending: await git.commitGraph.read([oid(1)], { uploadId: upload.uploadId }),
      lockedNow: git.locks.tryAcquire(LOCK_REF_COMMIT, "push-b", 1_000) === undefined,
      upload: git.uploads.get(upload.uploadId)?.state,
    }));
    expect(after.refs.version).toBe(0);
    expect(after.refs.refs.size).toBe(0);
    expect(after.live).toEqual([]);
    expect(after.verified).toEqual([undefined]);
    expect(after.pending[0]?.state).toBe("pending");
    expect(after.lockedNow).toBe(true);
    expect(after.upload).toBe("indexed");
    // Once the dead holder's lock expires, the retry commits. The object's
    // clock is moved past the expiry rather than waited for, so a slow run
    // cannot let the lock expire before the check above.
    const retried = await inRepo(stub, async ({ git }) => {
      setOffset(git, DEAD_LOCK_TTL + 1);
      const lock = await git.locks.acquire(LOCK_REF_COMMIT, "push-a-retry", {
        ttlMs: 30_000,
        waitMs: 5_000,
      });
      if (!lock) return "busy";
      try {
        return git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: main, oldOid: null, newOid: oid(1) }],
          expectedVersion: 0,
          uploadId: upload.uploadId,
        });
      } finally {
        git.locks.release(lock);
      }
    });
    expect(retried).toEqual({ ok: true, version: 1 });
  });

  it("runs the reflog prune job from the alarm, resuming after eviction", async () => {
    const { stub } = await newRepo();
    const now = Date.now();
    await runInDurableObject(stub, async ({ git }: RepoDO, state) => {
      const sql = git.context.storage.sql;
      for (let i = 0; i < 2_500; i++) {
        sql.exec(
          "INSERT INTO reflog (ref, version, at) VALUES (?, ?, ?)",
          main,
          i + 1,
          i < 2_400 ? now - REFLOG_RETENTION_MS - 60_000 : now,
        );
      }
      enqueueReflogPrune(git.jobs, now);
      // Hold the alarm back so the job is still pending when the object is evicted.
      await state.storage.setAlarm(now + 60 * 60 * 1000);
    });
    await evictDurableObject(stub);
    const pendingBefore = await inRepo(
      stub,
      ({ git }) =>
        git.context.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM reflog").one().n,
    );
    expect(pendingBefore).toBe(2_500);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const left = await inRepo(stub, ({ git }) => ({
      rows: git.context.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM reflog").one().n,
      jobs: git.context.storage.sql
        .exec<{ state: string }>("SELECT state FROM jobs WHERE kind = 'reflog_prune'")
        .toArray()
        .map((r) => r.state),
    }));
    expect(left).toEqual({ rows: 100, jobs: ["done"] });
  });
});

describe("RepoDO reflog retention", () => {
  it("prunes old reflog entries after ordinary commits, with a fresh cutoff each pass", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const { stub } = await newRepo();
    let version = 0;
    const commit = (n: number) =>
      inRepo(stub, ({ git }) => {
        const current = git.refStore.readRefsSync().refs.get(main) ?? null;
        const result = git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: main, oldOid: current, newOid: oid(n) }],
          expectedVersion: version,
        });
        if (!result.ok) throw new Error(`commit failed: ${result.reason}`);
        version = result.version;
      });
    const reflog = () =>
      inRepo(stub, ({ git }) =>
        git.context.storage.sql
          .exec<{ version: number }>("SELECT version FROM reflog ORDER BY seq")
          .toArray()
          .map((r) => r.version),
      );
    const pruneJob = () =>
      inRepo(stub, ({ git }) => {
        const job = git.jobs.get(REFLOG_PRUNE_JOB_ID);
        const at = git.context.storage.sql
          .exec<{ at: number }>(
            "SELECT next_run_at AS at FROM jobs WHERE job_id = ?",
            REFLOG_PRUNE_JOB_ID,
          )
          .toArray()[0]?.at;
        return { state: job?.state, inMs: at === undefined ? undefined : at - git.context.now() };
      });
    // Keep the clock moved ahead so the object's own alarms never fire during the test.
    await inRepo(stub, ({ git }) => setOffset(git, 365 * DAY));

    await commit(1);
    await commit(2);
    expect(await pruneJob()).toMatchObject({ state: "queued" });
    expect((await pruneJob()).inMs).toBeGreaterThan(REFLOG_RETENTION_MS - DAY);
    // Past the retention of the first two entries, a third commit; the pass runs on the alarm.
    await advance(stub, REFLOG_RETENTION_MS + 1);
    await commit(3);
    await advance(stub, DAY + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await reflog()).toEqual([3]);
    expect((await pruneJob()).state).toBe("done");

    // The next commit after the retention of entry 3 schedules another pass with its own cutoff.
    await advance(stub, REFLOG_RETENTION_MS);
    await commit(4);
    expect((await pruneJob()).state).toBe("queued");
    await advance(stub, DAY + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await reflog()).toEqual([4]);
  });
});

// Compare-and-set cases after git's t5533-push-cas (--force-with-lease) and
// t5543-atomic-push, at the storage level: the push path maps these results
// to report-status lines.
describe("RepoDO ref compare-and-set", () => {
  async function seeded() {
    const { stub } = await newRepo();
    await inRepo(stub, ({ git }) =>
      git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [
          { name: main, oldOid: null, newOid: oid(1) },
          { name: "refs/heads/next", oldOid: null, newOid: oid(2) },
        ],
        expectedVersion: 0,
      }),
    );
    return stub;
  }

  it("rejects a lease on a stale value and accepts one on the current value", async () => {
    const stub = await seeded();
    const results = await inRepo(stub, ({ git }) => [
      git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: main, oldOid: oid(9), newOid: oid(3) }],
        expectedVersion: 1,
      }),
      git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: main, oldOid: oid(1), newOid: oid(3) }],
        expectedVersion: 1,
      }),
    ]);
    expect(results).toEqual([
      { ok: false, reason: "ref-conflict", ref: main },
      { ok: true, version: 2 },
    ]);
  });

  it("rejects a create when the ref already exists, and a delete of a stale value", async () => {
    const stub = await seeded();
    const results = await inRepo(stub, ({ git }) => [
      git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/next", oldOid: null, newOid: oid(5) }],
        expectedVersion: 1,
      }),
      git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/next", oldOid: oid(1), newOid: null }],
        expectedVersion: 1,
      }),
    ]);
    expect(results).toEqual([
      { ok: false, reason: "ref-conflict", ref: "refs/heads/next" },
      { ok: false, reason: "ref-conflict", ref: "refs/heads/next" },
    ]);
  });

  it("applies an atomic multi-ref update all or nothing", async () => {
    const stub = await seeded();
    const result = await inRepo(stub, async ({ git }) => ({
      failed: git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [
          { name: main, oldOid: oid(1), newOid: oid(3) },
          { name: "refs/heads/next", oldOid: oid(7), newOid: oid(4) },
          { name: "refs/tags/v1", oldOid: null, newOid: oid(5) },
        ],
        expectedVersion: 1,
      }),
      refs: git.refStore.readRefsSync(),
      reflog: await git.refStore.readReflog(main, 10),
    }));
    expect(result.failed).toEqual({ ok: false, reason: "ref-conflict", ref: "refs/heads/next" });
    expect(result.refs.version).toBe(1);
    expect([...result.refs.refs.keys()].sort()).toEqual([main, "refs/heads/next"]);
    expect(result.refs.refs.get(main)).toEqual(oid(1));
    expect(result.reflog).toHaveLength(1);
  });
});
