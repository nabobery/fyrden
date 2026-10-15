import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ORPHAN_REAPER_JOB_ID,
  packObjectKey,
  type RepoGitStorage,
  UPLOAD_TTL_MS,
} from "@fyrden/adapters-cloudflare/git";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { indexedUpload, inRepo, newRepo, oid } from "./helpers/repo-git.js";

const enc = (text: string) => new TextEncoder().encode(text);

afterEach(() => {
  vi.useRealTimers();
});

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

/** A pushed and committed pack: it must survive every reaper run. */
async function committedPack(git: RepoGitStorage, n: number) {
  const upload = await indexedUpload(git, git.bucket, "usr_ok", [[n]]);
  const result = git.refStore.commitSync({
    addPacks: [],
    removePacks: [],
    refUpdates: [{ name: `refs/heads/b${n}`, oldOid: null, newOid: oid(n) }],
    expectedVersion: git.refStore.readRefsSync().version,
    uploadId: upload.uploadId,
  });
  if (!result.ok) throw new Error("commit failed");
  await git.bucket.put(packObjectKey(git.networkId(), upload.packId as string, "idx"), enc("IDX"));
  return upload;
}

/**
 * Runs the object's alarm until the reaper is done, moving the (faked)
 * clock past each slice's continuation delay. Returns the alarm runs.
 */
async function alarmsUntilReaped(stub: DurableObjectStub<RepoDO>, clock: { now: number }) {
  let runs = 0;
  for (let i = 0; i < 50; i++) {
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    runs++;
    const state = await inRepo(stub, ({ git }) => git.jobs.get(ORPHAN_REAPER_JOB_ID)?.state);
    if (state === "done") return runs;
    clock.now += 2_000;
    vi.setSystemTime(clock.now);
  }
  throw new Error("reaper never finished");
}

describe("reaper.orphaned-upload", () => {
  it("removes what a Worker that died after its R2 upload and before the commit left behind, after the TTL", async () => {
    // On the real clock: the reaper weighs an object's age by R2's upload date, which the
    // local bucket records in real time, not the clock the test setup holds ahead.
    vi.useRealTimers();
    const { stub, networkId } = await newRepo();
    const prefix = `net/${networkId}/`;
    const seeded = await inRepo(stub, async ({ git }) => {
      const committed = await committedPack(git, 1);
      // The push that died: pack, index and scratch in R2, a pending registry
      // row and pending commit rows, never committed.
      const dead = git.uploads.begin({
        networkId,
        principal: "usr_dead",
        commands: [],
        atomic: false,
        withPack: true,
        ttlMs: UPLOAD_TTL_MS,
        leaseTtlMs: 10 * 60 * 1000,
      });
      await git.bucket.put(dead.r2Key as string, enc("PACK"));
      await git.bucket.put(packObjectKey(networkId, dead.packId as string, "idx"), enc("IDX"));
      await git.bucket.put(`${prefix}scratch/${dead.uploadId}/0`, enc("checkpoint"));
      await git.commitGraph.insertPending(dead.uploadId, [
        { oid: oid(9), tree: oid(19), parents: [], commitTime: 1, generation: 1, level: 1 },
      ]);
      git.uploads.markUploaded(dead.uploadId, { bytes: 4 });
      // A chunked upload killed mid-multipart: the id was recorded before the first part.
      const chunked = git.uploads.begin({
        networkId,
        principal: "usr_dead",
        commands: [],
        atomic: false,
        withPack: true,
        ttlMs: UPLOAD_TTL_MS,
        leaseTtlMs: 10 * 60 * 1000,
      });
      const multipart = await git.bucket.createMultipartUpload(chunked.r2Key as string);
      git.uploads.recordMultipart(chunked.uploadId, multipart.uploadId);
      await multipart.uploadPart(1, new Uint8Array(1024).fill(1));
      // An object whose registry row is gone.
      await git.bucket.put(`${prefix}p/01ARZ3NDEKTSV4RRFFQ69G5FAV.pack`, enc("lost"));
      return {
        dead: dead.uploadId,
        chunked: { key: chunked.r2Key as string, id: multipart.uploadId },
        keep: [
          committed.r2Key as string,
          packObjectKey(networkId, committed.packId as string, "idx"),
        ].sort(),
      };
    });

    // Within the TTL nothing goes.
    const clock = { now: Date.now() + 60 * 60 * 1000 + 60_000 };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.now);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await listKeys(`${prefix}p/`)).length).toBe(5);

    clock.now += UPLOAD_TTL_MS;
    vi.setSystemTime(clock.now);
    await alarmsUntilReaped(stub, clock);

    const rows = await inRepo(stub, ({ git }) => {
      const n = (sql: string) => git.context.storage.sql.exec<{ n: number }>(sql).one().n;
      return {
        uploads: n("SELECT count(*) AS n FROM uploads WHERE state <> 'committed'"),
        packs: n("SELECT count(*) AS n FROM packs WHERE state <> 'live'"),
        pendingCommits: n("SELECT count(*) AS n FROM pending_commits"),
        live: n("SELECT count(*) AS n FROM packs WHERE state = 'live'"),
        refs: git.refStore.readRefsSync().refs.size,
      };
    });
    expect(rows).toEqual({ uploads: 0, packs: 0, pendingCommits: 0, live: 1, refs: 1 });
    // Orphaned objects under the pack prefix are back to zero; the committed pack stays.
    expect(await listKeys(`${prefix}p/`)).toEqual(seeded.keep);
    expect(await listKeys(`${prefix}scratch/`)).toEqual([]);
    // The incomplete multipart upload is aborted: its parts can no longer be added or completed.
    const resumed = env.GIT.resumeMultipartUpload(seeded.chunked.key, seeded.chunked.id);
    await expect(resumed.uploadPart(2, new Uint8Array(8))).rejects.toThrow(/does not exist/);

    // A second run is a no-op.
    await inRepo(stub, ({ git }) => {
      git.jobs.ensure("reap_orphans", ORPHAN_REAPER_JOB_ID, { runAt: git.context.now() });
    });
    await alarmsUntilReaped(stub, clock);
    expect(await listKeys(`${prefix}p/`)).toEqual(seeded.keep);
  });

  it("resumes after eviction between bounded alarm slices", async () => {
    const { stub, networkId } = await newRepo();
    const prefix = `net/${networkId}/p/`;
    const keep = await inRepo(stub, async ({ git }) => {
      const committed = await committedPack(git, 1);
      // More unregistered objects than one slice deletes (100, Proposed).
      for (let i = 0; i < 130; i++)
        await git.bucket.put(`${prefix}lost-${String(i).padStart(3, "0")}`, enc("x"));
      return [
        committed.r2Key as string,
        packObjectKey(networkId, committed.packId as string, "idx"),
      ];
    });
    const clock = { now: Date.now() + UPLOAD_TTL_MS + 60_000 };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.now);
    await inRepo(stub, ({ git }) => {
      git.jobs.ensure("reap_orphans", ORPHAN_REAPER_JOB_ID, { runAt: git.context.now() });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterOne = (await listKeys(prefix)).length;
    expect(afterOne).toBeGreaterThanOrEqual(32);
    expect(afterOne).toBeLessThan(132);

    await evictDurableObject(stub);
    clock.now += 2_000;
    vi.setSystemTime(clock.now);
    await alarmsUntilReaped(stub, clock);
    expect(await listKeys(prefix)).toEqual(keep.sort());
  });
});
