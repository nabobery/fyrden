import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Oid, oidFromBytes, type PackId } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import {
  indexJobId,
  ORPHAN_REAPER_JOB_ID,
  type OrphanReaperOptions,
  orphanReaperHandler,
  packObjectKey,
  RepoGitStorage,
  scheduleOrphanReaper,
} from "../../src/git/index.js";
import { R2PackStore } from "../../src/git/r2-pack-store.js";
import type { Metrics } from "../../src/obs/metrics.js";
import { inProbe, newProbe } from "./harness.js";
import type { GitStoreProbeDO, RecordedMetric } from "./probe-do.js";

const HOUR = 60 * 60 * 1000;
const TTL = 24 * HOUR;
const LEASE_TTL = 60_000;
const oid = (n: number): Oid => oidFromBytes(new Uint8Array(20).fill(n));
const enc = (text: string) => new TextEncoder().encode(text);

/** Survives evictions: the test isolate outlives the object's instances. */
type Clock = { now: number };

/** Every key the reaper asked R2 to delete, in order. */
type DeleteLog = string[];

function spyBucket(bucket: R2Bucket, deleted: DeleteLog): R2Bucket {
  return {
    head: (key: string) => bucket.head(key),
    get: (key: string, options?: R2GetOptions) => bucket.get(key, options),
    put: (key: string, value: never) => bucket.put(key, value),
    list: (options?: R2ListOptions) => bucket.list(options),
    createMultipartUpload: (key: string) => bucket.createMultipartUpload(key),
    resumeMultipartUpload: (key: string, id: string) => bucket.resumeMultipartUpload(key, id),
    delete: async (keys: string | string[]) => {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      await bucket.delete(keys);
    },
  } as unknown as R2Bucket;
}

/** The probe's storage with a clock, bucket spy and metrics the test controls. */
function clocked(
  probe: GitStoreProbeDO,
  clock: Clock,
  extra: { deleted?: DeleteLog; metrics?: RecordedMetric[] } = {},
): RepoGitStorage {
  const recorder: Metrics = {
    count: (name, dimensions, value = 1) => {
      extra.metrics?.push({ name, dimensions: dimensions as Record<string, string>, value });
    },
  };
  return new RepoGitStorage({
    storage: probe.git.context.storage,
    bucket: spyBucket(env.GIT, extra.deleted ?? []),
    bucketName: "fyrden-git-test",
    metrics: recorder,
    now: () => clock.now,
    jobPolicy: { leaseMs: 30_000, maxAttempts: 5, backoffMs: 1_000, memoryRetryMs: 1_000 },
  });
}

const SWEEP: OrphanReaperOptions = { sweepNetwork: () => true };

/**
 * Runs the reaper job until nothing is due, stepping the clock past each
 * slice's continuation delay. Returns the slices run.
 */
async function reap(git: RepoGitStorage, clock: Clock, options: OrphanReaperOptions = SWEEP) {
  const handler = orphanReaperHandler(git, { continueAfterMs: 1_000, ...options });
  let slices = 0;
  for (let i = 0; i < 200; i++) {
    const ran = await git.jobs.runDue({ reap_orphans: handler }, git.memory, clock.now + 1);
    if (ran === 0) break;
    slices += ran;
    clock.now += 1_000;
  }
  return slices;
}

const scratchKey = (networkId: string, uploadId: string, n: number) =>
  `net/${networkId}/scratch/${uploadId}/${n}`;

/**
 * An upload as a Worker that died after its R2 upload and before the
 * commit leaves it: pack, index and scratch objects in R2, pending commit
 * rows, a pending (or indexing) registry row; never committed.
 */
async function orphanUpload(
  git: RepoGitStorage,
  options: { uploaded?: boolean; ttlMs?: number; commit?: number } = {},
) {
  const networkId = git.networkId();
  const upload = git.uploads.begin({
    networkId,
    principal: "usr_dead",
    commands: [],
    atomic: false,
    withPack: true,
    ttlMs: options.ttlMs ?? TTL,
    leaseTtlMs: LEASE_TTL,
  });
  const packId = upload.packId as PackId;
  await env.GIT.put(upload.r2Key as string, enc("PACK"));
  await env.GIT.put(packObjectKey(networkId, packId, "idx"), enc("IDX"));
  await env.GIT.put(scratchKey(networkId, upload.uploadId, 0), enc("scratch"));
  await env.GIT.put(scratchKey(networkId, upload.uploadId, 1), enc("scratch"));
  const n = options.commit ?? 1;
  await git.commitGraph.insertPending(upload.uploadId, [
    { oid: oid(n), tree: oid(100 + n), parents: [], commitTime: 1, generation: 1, level: 1 },
  ]);
  if (options.uploaded !== false) git.uploads.markUploaded(upload.uploadId, { bytes: 4 });
  return { ...upload, packId };
}

/** A committed upload: its pack is live and must never be reaped. */
async function committedUpload(git: RepoGitStorage, n: number) {
  const upload = await orphanUpload(git, { commit: n });
  git.uploads.markIndexed(upload.uploadId, { deps: [], objectCount: 1 });
  const result = git.refStore.commitSync({
    addPacks: [],
    removePacks: [],
    refUpdates: [{ name: `refs/heads/b${n}`, oldOid: null, newOid: oid(n) }],
    expectedVersion: git.refStore.readRefsSync().version,
    uploadId: upload.uploadId,
  });
  if (!result.ok) throw new Error(`commit failed: ${JSON.stringify(result)}`);
  // The commit path deletes its scratch objects.
  const networkId = git.networkId();
  await env.GIT.delete([0, 1].map((n) => scratchKey(networkId, upload.uploadId, n)));
  return upload;
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.GIT.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

function count(git: RepoGitStorage, sql: string, ...bindings: unknown[]): number {
  return git.context.storage.sql.exec<{ n: number }>(sql, ...bindings).one().n;
}

function uploadRows(git: RepoGitStorage, uploadId: string, packId: string) {
  return {
    uploads: count(git, "SELECT count(*) AS n FROM uploads WHERE upload_id = ?", uploadId),
    packs: count(git, "SELECT count(*) AS n FROM packs WHERE pack_id = ?", packId),
    pendingCommits: count(
      git,
      "SELECT count(*) AS n FROM pending_commits WHERE upload_id = ?",
      uploadId,
    ),
    leases: count(git, "SELECT count(*) AS n FROM leases WHERE pack_id = ?", packId),
  };
}

const reaped = (metrics: RecordedMetric[], what: string) =>
  metrics
    .filter((m) => m.name === "git.reaped" && m.dimensions.what === what)
    .reduce((sum, m) => sum + m.value, 0);

describe("orphaned-upload reaper", () => {
  it("removes an upload that died before its commit, with its rows and R2 objects, only after the TTL", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const metrics: RecordedMetric[] = [];
    const result = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock, { metrics });
      const upload = await orphanUpload(git);
      const before = uploadRows(git, upload.uploadId, upload.packId);
      // Within the TTL nothing is touched, even after the index lease expired.
      clock.now += TTL - HOUR;
      scheduleOrphanReaper(git.jobs, clock.now);
      await reap(git, clock);
      const early = uploadRows(git, upload.uploadId, upload.packId);
      const earlyKeys = await listKeys(`net/${networkId}/`);
      clock.now += 2 * HOUR;
      await reap(git, clock);
      return {
        before,
        early,
        earlyKeys: earlyKeys.length,
        after: uploadRows(git, upload.uploadId, upload.packId),
        job: git.jobs.get(ORPHAN_REAPER_JOB_ID)?.state,
      };
    });
    expect(result.before).toEqual({ uploads: 1, packs: 1, pendingCommits: 1, leases: 1 });
    expect(result.early).toEqual({ uploads: 1, packs: 1, pendingCommits: 1, leases: 1 });
    expect(result.earlyKeys).toBe(4);
    expect(result.after).toEqual({ uploads: 0, packs: 0, pendingCommits: 0, leases: 0 });
    expect(result.job).toBe("done");
    expect(await listKeys(`net/${networkId}/`)).toEqual([]);
    expect(reaped(metrics, "upload")).toBe(1);
    expect(reaped(metrics, "pack")).toBe(1);
  });

  it("schedules itself when an upload begins, at the upload's expiry", async () => {
    const { stub } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const result = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      const a = await orphanUpload(git);
      clock.now += 10;
      await orphanUpload(git, { commit: 2 });
      const jobs = git.context.storage.sql
        .exec<{ job_id: string; next_run_at: number; state: string }>(
          "SELECT job_id, next_run_at, state FROM jobs WHERE kind = 'reap_orphans'",
        )
        .toArray();
      return { jobs, expiresAt: a.expiresAt };
    });
    expect(result.jobs).toEqual([
      { job_id: ORPHAN_REAPER_JOB_ID, next_run_at: result.expiresAt, state: "queued" },
    ]);
  });

  it("aborts an incomplete multipart upload by its stored id", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const outcome = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      const upload = git.uploads.begin({
        networkId,
        principal: "usr_dead",
        commands: [],
        atomic: false,
        withPack: true,
        ttlMs: TTL,
        leaseTtlMs: LEASE_TTL,
      });
      const key = upload.r2Key as string;
      // The id is recorded before the first part, so a Worker killed mid-upload leaves it behind.
      const multipart = await env.GIT.createMultipartUpload(key);
      expect(git.uploads.recordMultipart(upload.uploadId, multipart.uploadId)).toBe(true);
      const part = await multipart.uploadPart(1, new Uint8Array(1024).fill(7));
      clock.now += TTL + 1;
      await reap(git, clock);
      const resumed = env.GIT.resumeMultipartUpload(key, multipart.uploadId);
      const errors: string[] = [];
      await resumed.uploadPart(2, new Uint8Array(16)).catch((e: Error) => errors.push(e.message));
      await resumed.complete([part]).catch((e: Error) => errors.push(e.message));
      return {
        errors,
        object: (await env.GIT.head(key)) !== null,
        rows: count(git, "SELECT count(*) AS n FROM uploads WHERE upload_id = ?", upload.uploadId),
      };
    });
    expect(outcome.errors).toHaveLength(2);
    for (const message of outcome.errors) expect(message).toMatch(/does not exist/);
    expect(outcome.object).toBe(false);
    expect(outcome.rows).toBe(0);
  });

  it("never touches a committed pack, a leased pack, or an upload whose indexing is still active", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const result = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      const committed = await committedUpload(git, 1);
      // Superseded and condemned packs belong to GC, never to this reaper.
      const superseded = await committedUpload(git, 2);
      const condemned = await committedUpload(git, 3);
      git.context.storage.sql.exec(
        "UPDATE packs SET state = 'superseded' WHERE pack_id = ?",
        superseded.packId,
      );
      git.context.storage.sql.exec(
        "UPDATE packs SET state = 'condemned' WHERE pack_id = ?",
        condemned.packId,
      );
      // A reader holds a lease on an expired upload's pack.
      const leased = await orphanUpload(git, { commit: 4 });
      // An expired upload whose indexer keeps renewing its index lease.
      const renewing = await orphanUpload(git, { commit: 5 });
      // An expired upload whose resumable index job is still queued.
      const queued = await orphanUpload(git, { commit: 6 });
      git.jobs.ensure("index", indexJobId(queued.uploadId), { runAt: clock.now + 10 * TTL });
      const dead = await orphanUpload(git, { commit: 7 });
      // A delete-only upload (no pack) whose check holds a lease on a pack it relies on.
      const holding = git.uploads.begin({
        networkId,
        principal: "usr_live",
        commands: [],
        atomic: false,
        withPack: false,
        ttlMs: TTL,
        leaseTtlMs: LEASE_TTL,
      });

      clock.now += TTL + HOUR;
      const read = git.leases.grant("read", [leased.packId], "clone-1", HOUR);
      if (!read.ok) throw new Error("read lease refused");
      const dep = git.leases.grant("index", [committed.packId], holding.uploadId, HOUR);
      if (!dep.ok) throw new Error("dependency lease refused");
      const indexLease = git.context.storage.sql
        .exec<{ lease_id: string }>(
          "SELECT lease_id FROM leases WHERE holder = ?",
          renewing.uploadId,
        )
        .one().lease_id;
      git.context.storage.sql.exec(
        "UPDATE leases SET expires_at = ? WHERE lease_id = ?",
        clock.now + HOUR,
        indexLease,
      );
      await reap(git, clock);
      const state = (id: string) => git.uploads.get(id)?.state ?? "gone";
      const first = {
        leased: state(leased.uploadId),
        renewing: state(renewing.uploadId),
        queued: state(queued.uploadId),
        dead: state(dead.uploadId),
        holding: state(holding.uploadId),
        packs: git.context.storage.sql
          .exec<{ pack_id: string; state: string }>("SELECT pack_id, state FROM packs")
          .toArray()
          .map((r) => r.state)
          .sort(),
      };
      // Once the lease ends and the indexer stops, they are reaped too.
      git.context.storage.sql.exec(
        "UPDATE jobs SET state = 'failed' WHERE job_id = ?",
        indexJobId(queued.uploadId),
      );
      clock.now += 2 * HOUR;
      await reap(git, clock);
      return {
        first,
        second: {
          leased: state(leased.uploadId),
          renewing: state(renewing.uploadId),
          queued: state(queued.uploadId),
          holding: state(holding.uploadId),
        },
        keepKeys: [committed, superseded, condemned].flatMap((u) => [
          u.r2Key as string,
          packObjectKey(networkId, u.packId, "idx"),
        ]),
      };
    });
    expect(result.first).toEqual({
      leased: "indexing",
      renewing: "indexing",
      queued: "indexing",
      dead: "gone",
      holding: "open",
      packs: ["condemned", "indexing", "indexing", "indexing", "live", "superseded"],
    });
    expect(result.second).toEqual({
      leased: "gone",
      renewing: "gone",
      queued: "gone",
      holding: "gone",
    });
    expect(await listKeys(`net/${networkId}/p/`)).toEqual(result.keepKeys.sort());
  });

  it("sweeps unregistered objects under the pack prefix past the TTL, only for a network of one", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const prefix = `net/${networkId}/p/`;
    const result = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      const committed = await committedUpload(git, 1);
      // Objects with no registry row: a pack and index from a lost row, and a stray key.
      const lost = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
      await env.GIT.put(`${prefix}${lost}.pack`, enc("lost"));
      await env.GIT.put(`${prefix}${lost}.idx`, enc("lost"));
      await env.GIT.put(`${prefix}stray`, enc("stray"));
      clock.now += TTL + HOUR;
      // Shared networks are swept by the network object, never by one member.
      scheduleOrphanReaper(git.jobs, clock.now);
      await reap(git, clock, { sweepNetwork: () => false });
      const shared = await listKeys(prefix);
      scheduleOrphanReaper(git.jobs, clock.now);
      await reap(git, clock);
      return {
        shared,
        keep: [committed.r2Key as string, packObjectKey(networkId, committed.packId, "idx")],
      };
    });
    expect(result.shared).toHaveLength(5);
    expect(await listKeys(prefix)).toEqual(result.keep.sort());

    // An unregistered object younger than the TTL is kept (its row may be on its way).
    const young = `${prefix}01ARZ3NDEKTSV4RRFFQ69G5FAW.pack`;
    await env.GIT.put(young, enc("young"));
    const realClock: Clock = { now: Date.now() };
    await inProbe(stub, async (probe) => {
      const git = clocked(probe, realClock);
      scheduleOrphanReaper(git.jobs, realClock.now);
      await reap(git, realClock);
    });
    expect(await listKeys(prefix)).toContain(young);
  });

  it("removes an upload with more pack files than one slice may delete, a few packs per slice", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const deleted: DeleteLog = [];
    const metrics: RecordedMetric[] = [];
    const result = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock, { deleted, metrics });
      const upload = await orphanUpload(git);
      // Interrupted attempts left five more packs in the upload's unit.
      const extra: string[] = [];
      for (let i = 0; i < 5; i++) {
        const writer = git.packStore.beginUnitPack({
          kind: "completion",
          unitId: upload.uploadId,
          uploadId: upload.uploadId,
        });
        await writer.write(enc(`attempt ${i}`));
        await writer.finish();
        await env.GIT.put(packObjectKey(networkId, writer.packId, "idx"), enc("IDX"));
        extra.push(writer.packId);
      }
      clock.now += TTL + 1;
      scheduleOrphanReaper(git.jobs, clock.now);
      // 6 packs: 12 files and 2 scratch objects, 4 deletions per slice.
      const slices = await reap(git, clock, { ...SWEEP, maxDeletionsPerSlice: 4 });
      return {
        slices,
        rows: [upload.packId, ...extra].map((id) => uploadRows(git, upload.uploadId, id)),
        job: git.jobs.get(ORPHAN_REAPER_JOB_ID)?.state,
      };
    });
    expect(result.rows.every((r) => r.uploads === 0 && r.packs === 0)).toBe(true);
    expect(result.job).toBe("done");
    expect(result.slices).toBeGreaterThan(3);
    expect(await listKeys(`net/${networkId}/`)).toEqual([]);
    expect(new Set(deleted).size).toBe(14);
    expect(reaped(metrics, "upload")).toBe(1);
    expect(reaped(metrics, "pack")).toBe(6);
  });

  it("reaps discarded packs and upload-less pending packs past the TTL", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const result = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      const store = new R2PackStore(git.context, {
        bucket: env.GIT,
        bucketName: "fyrden-git-test",
        registry: git.registry,
        networkId: () => networkId,
      });
      // A writer the object abandoned (pending, no upload) and one it aborted (discarded).
      const abandoned = store.beginPack();
      await env.GIT.put(packObjectKey(networkId, abandoned.packId, "pack"), enc("abandoned"));
      const aborted = store.beginPack();
      await aborted.abort();
      await env.GIT.put(packObjectKey(networkId, aborted.packId, "pack"), enc("aborted"));
      scheduleOrphanReaper(git.jobs, clock.now);
      await reap(git, clock);
      const early = count(git, "SELECT count(*) AS n FROM packs");
      clock.now += TTL + 1;
      scheduleOrphanReaper(git.jobs, clock.now);
      await reap(git, clock);
      return { early, after: count(git, "SELECT count(*) AS n FROM packs") };
    });
    expect(result).toEqual({ early: 2, after: 0 });
    expect(await listKeys(`net/${networkId}/`)).toEqual([]);
  });

  it("bounds each slice, resumes after eviction mid-pass without double effects, and a second pass is a no-op", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const metrics: RecordedMetric[] = [];
    const deleted: DeleteLog = [];
    const options: OrphanReaperOptions = { ...SWEEP, maxDeletionsPerSlice: 5 };
    const prefix = `net/${networkId}/`;
    const setup = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock, { metrics, deleted });
      const uploads = [];
      for (let i = 0; i < 6; i++) uploads.push(await orphanUpload(git, { commit: 10 + i }));
      for (let i = 0; i < 7; i++)
        await env.GIT.put(
          `${prefix}p/01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, "0")}.pack`,
          enc("x"),
        );
      const committed = await committedUpload(git, 1);
      clock.now += TTL + 1;
      // One slice, then the next slice "dies" with the object after its R2
      // deletes and before its row deletes: its claim is left behind.
      const handler = orphanReaperHandler(git, { ...options, continueAfterMs: 1_000 });
      await git.jobs.runDue({ reap_orphans: handler }, git.memory, clock.now + 1);
      const firstSlice = deleted.length;
      const victim = uploads.find((u) => git.uploads.get(u.uploadId)) as (typeof uploads)[number];
      await env.GIT.delete([
        victim.r2Key as string,
        packObjectKey(networkId, victim.packId, "idx"),
      ]);
      clock.now += 1_000;
      git.context.storage.sql.exec(
        "UPDATE jobs SET state = 'running', lease_expires_at = ? WHERE job_id = ?",
        clock.now + 30_000,
        ORPHAN_REAPER_JOB_ID,
      );
      return { firstSlice, committed };
    });
    expect(setup.firstSlice).toBeGreaterThan(0);
    expect(setup.firstSlice).toBeLessThanOrEqual(5);

    await evictDurableObject(stub);

    const resumed = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock, { metrics, deleted });
      const handler = orphanReaperHandler(git, { ...options, continueAfterMs: 1_000 });
      // The dead slice's claim holds the job until its lease expires.
      const blocked = await git.jobs.runDue({ reap_orphans: handler }, git.memory, clock.now + 1);
      clock.now += 30_000;
      const perSlice: number[] = [];
      for (let i = 0; i < 100; i++) {
        const before = deleted.length;
        const ran = await git.jobs.runDue({ reap_orphans: handler }, git.memory, clock.now + 1);
        if (ran === 0) break;
        perSlice.push(deleted.length - before);
        clock.now += 1_000;
      }
      return {
        blocked,
        perSlice,
        job: git.jobs.get(ORPHAN_REAPER_JOB_ID)?.state,
        uploads: count(git, "SELECT count(*) AS n FROM uploads WHERE state <> 'committed'"),
        pending: count(git, "SELECT count(*) AS n FROM pending_commits"),
        packs: count(git, "SELECT count(*) AS n FROM packs WHERE state <> 'live'"),
      };
    });
    expect(resumed.blocked).toBe(0);
    expect(resumed.perSlice.length).toBeGreaterThan(1);
    for (const n of resumed.perSlice) expect(n).toBeLessThanOrEqual(5);
    expect(resumed).toMatchObject({ job: "done", uploads: 0, pending: 0, packs: 0 });
    expect(await listKeys(prefix)).toEqual(
      [
        setup.committed.r2Key as string,
        packObjectKey(networkId, setup.committed.packId, "idx"),
      ].sort(),
    );
    // Each upload counted once, each unregistered object once.
    expect(reaped(metrics, "upload")).toBe(6);
    expect(reaped(metrics, "object")).toBe(7);

    // A second pass finds nothing to do.
    const deletesBefore = deleted.length;
    const metricsBefore = metrics.filter((m) => m.name === "git.reaped").length;
    await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock, { metrics, deleted });
      scheduleOrphanReaper(git.jobs, clock.now);
      await reap(git, clock, options);
    });
    expect(deleted.length).toBe(deletesBefore);
    expect(metrics.filter((m) => m.name === "git.reaped").length).toBe(metricsBefore);
  });
});
