// Resumable indexing: the index job saves its cursor after every phase; an
// evicted object continues from the cursor on its alarm (never redoing a
// finished phase), the ref moves only at the commit after indexing, and the
// client gets its report.
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { indexJobId, type Job, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { oidToHex, PushIndexer } from "@fyrden/git-core";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { PACK_CAP_DEFAULTS } from "../src/git/maintenance/tail-merge-plan.js";
import { PushCursorStore } from "../src/git/push/record.js";
import { RepoPush } from "../src/git/push/repo-push.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";
const DAY = 24 * 60 * 60 * 1000;
/** Past the upload's index lock (5 min). */
const PAST_INDEX_LOCK_MS = 10 * 60 * 1000;

/** `target` with every property passed through, except those in `overrides`. */
function overriding<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop in overrides) return overrides[prop as keyof T];
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("push: resumable indexing", () => {
  it("continues from its cursor after eviction, on the alarm, and moves the ref only at the commit", async () => {
    // Every clock in this isolate (the Worker's and the object's, which
    // survives eviction) runs a day ahead of real time, so the alarms the
    // job queue arms never fire on their own: only `runDurableObjectAlarm`
    // runs the job. An alarm firing by itself would race the assertions
    // below, and an eviction during its slice would leave the job leased.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + DAY);
    const target = await pushTarget();
    const { stub } = target.repo;
    const seeded = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
    );
    expect(seeded.report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);

    const begun = await stub.beginPush({ principal: target.owner.principalId, tokenId: "tok_r" });
    if (!begun.ok) throw new Error(begun.error);
    const body = pushBody([{ old: fx.c2, new: fx.c3, ref: MAIN }], { pack: fx.packC3ThinOnC2 });
    await env.GIT.put(begun.bodyKey, body);

    const look = () =>
      inRepo(stub, async ({ git }) => {
        const upload = git.uploads.get(begun.uploadId);
        const cursor = git.uploads.cursorOf(begun.uploadId);
        const received = upload?.packId ? await git.bucket.head(upload.r2Key as string) : null;
        return {
          main: oidToHex(git.refStore.readRefsSync().refs.get(MAIN) as never),
          upload: upload?.state,
          phase: cursor && cursor[0] === 0 ? PushIndexer.resume(cursor.subarray(1)).phase : null,
          job: git.jobs.get(indexJobId(begun.uploadId))?.state,
          receivedEtag: received?.etag ?? null,
        };
      });

    // One phase in the request (budget 0), then the object goes away.
    const first = await stub.runPush(begun.uploadId, body.length, 0);
    expect(first).toEqual({ state: "indexing", sideband: true });
    const afterParse = await look();
    expect(afterParse).toMatchObject({ main: fx.c2, upload: "indexing", phase: "completion" });
    expect(afterParse.receivedEtag).not.toBeNull();
    await evictDurableObject(stub);

    // The alarm continues the job, phase by phase, across more evictions.
    const phases = new Set<string | null>();
    for (let i = 0; i < 20; i++) {
      const now = await look();
      phases.add(now.phase);
      expect(now.main).toBe(fx.c2);
      if (now.job === "done") break;
      await runDurableObjectAlarm(stub);
      await evictDurableObject(stub);
    }
    const indexed = await look();
    expect(indexed).toMatchObject({ main: fx.c2, upload: "indexed", phase: "done", job: "done" });
    // The parse was never redone: the received pack is the one written before the eviction.
    expect(indexed.receivedEtag).toBe(afterParse.receivedEtag);
    expect(phases.has("parse")).toBe(false);

    expect(await stub.pushStatus(begun.uploadId, 0)).toEqual({ state: "ready", sideband: true });
    const response = await stub.finalizePush(begun.uploadId, {
      tokenId: "tok_r",
      decidedAt: Date.now(),
    });
    expect(reportLines(response).report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
    expect((await look()).main).toBe(fx.c3);
    // A lost answer is recovered from the object: the committed push kept its response.
    expect(await stub.pushStatus(begun.uploadId, 0)).toEqual({ state: "done", response });
  });
  it("publishes nothing from a runner that lost the index lock while its cursor write was under way", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + DAY);
    const target = await pushTarget();
    const { stub } = target.repo;
    const seeded = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
    );
    expect(seeded.report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
    const begun = await stub.beginPush({ principal: target.owner.principalId, tokenId: "tok_t" });
    if (!begun.ok) throw new Error(begun.error);
    const { uploadId } = begun;
    const body = pushBody([{ old: fx.c2, new: fx.c3, ref: MAIN }], { pack: fx.packC3ThinOnC2 });
    await env.GIT.put(begun.bodyKey, body);
    // Planned, and the first phase run: the job continues from here.
    expect(await stub.runPush(uploadId, body.length, 0)).toEqual({
      state: "indexing",
      sideband: true,
    });

    const seen = await inRepo(stub, async (repo) => {
      const git = repo.git;
      // Runner A's next cursor write (to R2: every cursor goes there here) stalls until released.
      let entered = () => {};
      const atWrite = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let stalled = false;
      const bucket = overriding(git.bucket, {
        put: (async (key: string, ...rest: unknown[]) => {
          if (!stalled && key.includes("/cursor")) {
            stalled = true;
            entered();
            await released;
          }
          return (git.bucket.put as (...args: unknown[]) => unknown)(key, ...rest);
        }) as R2Bucket["put"],
      });
      const runner = (storage: RepoGitStorage) =>
        new RepoPush(
          storage,
          git.context.metrics,
          createLogger({ test: "index-takeover" }),
          () => PACK_CAP_DEFAULTS,
          undefined,
          0,
        ).indexHandler();
      const job: Job = {
        jobId: indexJobId(uploadId),
        kind: "index",
        cursor: null,
        attempts: 0,
        claim: 0,
      };
      const cursors = new PushCursorStore(git, git.context.metrics);
      const phase = async () => PushIndexer.resume(await cursors.load(uploadId)).phase;

      const a = runner(overriding(git, { bucket })).runSlice(job);
      await atWrite;
      // A's lock expires while its write is under way; B takes the upload over and finishes it.
      const realNow = git.context.now;
      (git.context as { now: () => number }).now = () => realNow() + PAST_INDEX_LOCK_MS;
      const b = runner(git);
      for (let i = 0; i < 20 && !(await b.runSlice(job)).done; i++);
      const afterB = { state: git.uploads.get(uploadId)?.state, phase: await phase() };
      // A's write lands last.
      release();
      const slice = await a;
      (git.context as { now: () => number }).now = realNow;
      return {
        afterB,
        slice,
        afterA: { state: git.uploads.get(uploadId)?.state, phase: await phase() },
      };
    });
    expect(seen.afterB).toEqual({ state: "indexed", phase: "done" });
    expect(seen.slice.done).toBe(false);
    expect(seen.afterA).toEqual({ state: "indexed", phase: "done" });
    const response = await stub.finalizePush(uploadId, { tokenId: "tok_t", decidedAt: Date.now() });
    expect(reportLines(response).report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
    // Nothing of the push is left in scratch, A's stray cursor included.
    const scratch = await inRepo(stub, async ({ git }) =>
      (await env.GIT.list({ prefix: `net/${git.networkId()}/scratch/${uploadId}/` })).objects.map(
        (o) => o.key,
      ),
    );
    expect(scratch).toEqual([]);
  });

  it("waits for a runner that still holds the index lock without spending the job's attempts", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + DAY);
    const target = await pushTarget();
    const { stub } = target.repo;
    const seeded = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
    );
    expect(seeded.report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
    const begun = await stub.beginPush({ principal: target.owner.principalId, tokenId: "tok_l" });
    if (!begun.ok) throw new Error(begun.error);
    const body = pushBody([{ old: fx.c2, new: fx.c3, ref: MAIN }], { pack: fx.packC3ThinOnC2 });
    await env.GIT.put(begun.bodyKey, body);
    expect(await stub.runPush(begun.uploadId, body.length, 0)).toEqual({
      state: "indexing",
      sideband: true,
    });
    // An earlier runner whose job claim expired is still indexing: it holds the lock.
    const held = await inRepo(stub, ({ git }) =>
      git.locks.tryAcquire(`push-index:${begun.uploadId}`, "index", 60 * 60 * 1000),
    );
    expect(held).toBeDefined();
    const job = () => inRepo(stub, ({ git }) => git.jobs.get(indexJobId(begun.uploadId)));
    // More polls than the job's attempt limit (10).
    for (let i = 0; i < 12; i++) {
      expect(await stub.pushStatus(begun.uploadId, 0)).toEqual({
        state: "indexing",
        sideband: true,
      });
    }
    expect(await job()).toMatchObject({ state: "queued", attempts: 0 });
    await inRepo(stub, ({ git }) => git.locks.release(held as NonNullable<typeof held>));
    let status = await stub.pushStatus(begun.uploadId, 60_000);
    for (let i = 0; i < 10 && status.state === "indexing"; i++)
      status = await stub.pushStatus(begun.uploadId, 60_000);
    expect(status).toEqual({ state: "ready", sideband: true });
    expect(await job()).toMatchObject({ state: "done", attempts: 0 });
  });
});
