// Deployed, a Durable Object's input gate does not hold back other requests
// while it awaits R2 (measured 2026-10-11); under the local test pool it does.
// So this test does not rely on R2 latency: push A takes the ref-commit lock
// and then pauses inside its R2 await on a test signal (a timer wait, during
// which other requests run in both environments). Repack B, push C and push
// D run in that window, which the event order proves. The lock and the single
// commit transaction must keep refs and registry consistent, and C and D must
// wait or fail cleanly.
import {
  LOCK_MAINTENANCE,
  LOCK_REF_COMMIT,
  type PackId,
  type RepoCommitResult,
} from "@fyrden/adapters-cloudflare/git";
import { describe, expect, it } from "vitest";
import { indexedUpload, inRepo, newRepo, oid, pausingHead, signal } from "./helpers/repo-git.js";

const LOCK_TTL = 30_000;
const main = "refs/heads/main";

describe("RepoDO: explicit locks across an R2 await", () => {
  it("keeps refs and registry consistent while push A awaits R2 holding the lock", async () => {
    const { stub } = await newRepo();

    // Base state: pack P1 live, main -> X at version 1. Then three indexed uploads.
    const setup = await inRepo(stub, async ({ git }) => {
      const base = await indexedUpload(git, git.bucket, "usr_base", [[10]]);
      const seeded = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: main, oldOid: null, newOid: oid(10) }],
        expectedVersion: 0,
        uploadId: base.uploadId,
      });
      const a = await indexedUpload(git, git.bucket, "usr_a", [[11, 10]], [base.packId as string]);
      const c = await indexedUpload(git, git.bucket, "usr_c", [[12, 10]]);
      const d = await indexedUpload(git, git.bucket, "usr_d", [[13, 10]]);
      return { seeded, p1: base.packId as PackId, a, c, d };
    });
    expect(setup.seeded).toEqual({ ok: true, version: 1 });

    const r2Pause = signal();
    const aInsideAwait = signal();
    // What ran, in order: proves B, C and D ran while A was inside its R2
    // await, so it is the lock, not the input gate, that kept them apart.
    const events: string[] = [];
    const bWaitingForLock = signal();

    // Push A: takes the lock, reads the version, then awaits R2 (paused) before committing.
    const pushA = inRepo(stub, async ({ git }) => {
      const lock = await git.locks.acquire(LOCK_REF_COMMIT, "push-a", {
        ttlMs: LOCK_TTL,
        waitMs: 0,
      });
      if (!lock) return { ok: false, reason: "busy" } as const;
      try {
        const { version } = git.refStore.state();
        const stored = await pausingHead(git.bucket, r2Pause, aInsideAwait).head(
          setup.a.r2Key as string,
        );
        events.push("A resumed");
        if (!stored) throw new Error("upload bytes missing");
        return git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [{ name: main, oldOid: oid(10), newOid: oid(11) }],
          expectedVersion: version,
          uploadId: setup.a.uploadId,
          fastForward: new Set([main]),
          actor: { principal: "usr_a", via: "push" },
          authorize: () => (git.locks.isHeld(lock) ? undefined : "lost the ref-commit lock"),
        });
      } finally {
        git.locks.release(lock);
      }
    });
    await aInsideAwait.wait();

    // Repack B: maintenance lock, reads P1 from R2 and writes a compacted pack
    // during A's await, then waits for the ref-commit lock to swap.
    const repackB = inRepo(stub, async ({ git }) =>
      git.locks.withLock(LOCK_MAINTENANCE, "repack-b", { ttlMs: LOCK_TTL, waitMs: 0 }, async () => {
        events.push("B started");
        let expected = git.refStore.state().version;
        const sources = (await git.packStore.listPacks()).map((p) => p.packId);
        const writer = git.packStore.beginPack();
        for (const packId of sources) {
          const pack = git.registry.get(packId);
          await writer.write(await git.packStore.openRange(packId, 0, pack?.bytes ?? 0));
        }
        const compacted = await writer.finish();
        const swapped = git.locks.withLock(
          LOCK_REF_COMMIT,
          "repack-b",
          { ttlMs: LOCK_TTL, waitMs: 10_000 },
          async () => {
            const attempts: RepoCommitResult[] = [];
            for (;;) {
              // Optimistic: commit against the version read at the start; on a
              // conflict, check the sources are still live and retry on the new version.
              const result = git.refStore.commitSync({
                addPacks: [compacted.packId],
                removePacks: sources,
                refUpdates: [],
                expectedVersion: expected,
              });
              attempts.push(result);
              if (result.ok || result.reason !== "version-conflict") return attempts;
              const live = new Set((await git.packStore.listPacks()).map((p) => p.packId));
              if (!sources.every((id) => live.has(id))) return attempts;
              expected = result.version;
            }
          },
        );
        bWaitingForLock.open();
        return { compacted: compacted.packId, sources, swap: await swapped };
      }),
    );
    await bWaitingForLock.wait();

    // While A is still paused: C fails at once, nothing has moved.
    const pushC = await inRepo(stub, async ({ git }) => {
      const lock = await git.locks.acquire(LOCK_REF_COMMIT, "push-c", {
        ttlMs: LOCK_TTL,
        waitMs: 0,
      });
      events.push("C ran");
      if (lock) {
        git.locks.release(lock);
        return { busy: false };
      }
      git.uploads.abort(setup.c.uploadId);
      return { busy: true };
    });
    expect(pushC).toEqual({ busy: true });
    const during = await inRepo(stub, async ({ git }) => ({
      refs: git.refStore.readRefsSync(),
      live: (await git.packStore.listPacks()).map((p) => p.packId),
    }));
    expect(during.refs.version).toBe(1);
    expect(during.refs.refs.get(main)).toEqual(oid(10));
    expect(during.live).toEqual([setup.p1]);

    // Push D waits for the lock, behind B. `withLock` joins the lock's wait
    // queue before its first await, so D is queued once `dWaiting` opens.
    const dWaiting = signal();
    const pushD = inRepo(stub, async ({ git }) => {
      events.push("D started");
      const locked = git.locks.withLock(
        LOCK_REF_COMMIT,
        "push-d",
        { ttlMs: LOCK_TTL, waitMs: 10_000 },
        async () =>
          git.refStore.commitSync({
            addPacks: [],
            removePacks: [],
            refUpdates: [{ name: main, oldOid: oid(10), newOid: oid(13) }],
            expectedVersion: git.refStore.state().version,
            uploadId: setup.d.uploadId,
          }),
      );
      dWaiting.open();
      const result = await locked;
      if (!result.ok || !result.value.ok) git.uploads.abort(setup.d.uploadId);
      return result;
    });
    await dWaiting.wait();

    r2Pause.open();
    const [a, b, d] = await Promise.all([pushA, repackB, pushD]);

    expect(events.slice(0, 4)).toEqual(["B started", "C ran", "D started", "A resumed"]);
    expect(a).toEqual({ ok: true, version: 2 });
    expect(b.ok && b.value.swap.ok && b.value.swap.value).toEqual([
      { ok: false, reason: "version-conflict", version: 2 },
      { ok: true, version: 3 },
    ]);
    // D waited, then lost the compare-and-set cleanly: main had moved.
    expect(d).toEqual({ ok: true, value: { ok: false, reason: "ref-conflict", ref: main } });

    const final = await inRepo(stub, async ({ git }) => {
      const state = (packId: string | null) => (packId ? git.registry.get(packId)?.state : null);
      const sql = git.context.storage.sql;
      return {
        refs: git.refStore.readRefsSync(),
        reflog: (await git.refStore.readReflog(main, 10)).map((e) => [e.version, e.newOid?.[0]]),
        live: new Set((await git.packStore.listPacks()).map((p) => p.packId)),
        states: [state(setup.p1), state(setup.c.packId), state(setup.d.packId)],
        verified: (await git.commitGraph.read([oid(11), oid(12), oid(13)], "verified")).map(
          (e) => e?.state ?? null,
        ),
        pending: sql.exec<{ n: number }>("SELECT count(*) AS n FROM pending_commits").one().n,
        locks: sql.exec<{ n: number }>("SELECT count(*) AS n FROM locks").one().n,
        leases: sql.exec<{ n: number }>("SELECT count(*) AS n FROM leases").one().n,
        uploads: [setup.a, setup.c, setup.d].map((u) => git.uploads.get(u.uploadId)?.state),
      };
    });
    expect(final.refs.version).toBe(3);
    expect(final.refs.refs.get(main)).toEqual(oid(11));
    expect(final.reflog).toEqual([
      [2, 11],
      [1, 10],
    ]);
    expect(b.ok && final.live).toEqual(new Set([setup.a.packId, b.ok && b.value.compacted]));
    expect(final.states).toEqual(["superseded", "discarded", "discarded"]);
    expect(final.verified).toEqual(["verified", null, null]);
    expect(final.pending).toBe(0);
    expect(final.locks).toBe(0);
    expect(final.leases).toBe(0);
    expect(final.uploads).toEqual(["committed", "rejected", "rejected"]);
  });

  it("lets exactly one of two pushes with the same old value win, across awaits", async () => {
    const { stub } = await newRepo();
    const uploads = await inRepo(stub, async ({ git }) => {
      const base = await indexedUpload(git, git.bucket, "usr_base", [[1]]);
      git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: main, oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
        uploadId: base.uploadId,
      });
      return Promise.all([2, 3].map((n) => indexedUpload(git, git.bucket, `usr_${n}`, [[n, 1]])));
    });
    // No lock here: both read the version and await R2, and neither commits
    // until both have read (each waits for the other's signal, a timer wait
    // during which the other request runs). The transaction's compare-and-set
    // alone decides.
    const read = [signal(), signal()] as const;
    const both = await Promise.all(
      uploads.map((upload, i) =>
        inRepo(stub, async ({ git }) => {
          const { version } = git.refStore.state();
          await git.bucket.head(upload.r2Key as string);
          read[i]?.open();
          await read[1 - i]?.wait();
          return git.refStore.commitSync({
            addPacks: [],
            removePacks: [],
            refUpdates: [{ name: main, oldOid: oid(1), newOid: oid(i + 2) }],
            expectedVersion: version,
            uploadId: upload.uploadId,
          });
        }),
      ),
    );
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, reason: "version-conflict" });
    const version = await inRepo(stub, ({ git }) => git.refStore.state().version);
    expect(version).toBe(2);
  });
});
