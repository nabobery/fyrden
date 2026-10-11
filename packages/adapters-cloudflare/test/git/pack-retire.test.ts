import { env } from "cloudflare:workers";
import type { PackId } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { fetchObjectKey, newPackId, packObjectKey } from "../../src/git/keys.js";
import { packRetireHandler, RETIRE_JOB_ID } from "../../src/git/pack-retire.js";
import { RepoGitStorage } from "../../src/git/repo-git-storage.js";
import { inProbe, newProbe } from "./harness.js";
import type { GitStoreProbeDO } from "./probe-do.js";

/*
 * The retire job: superseded packs are condemned at once and deleted 30
 * days after they left the live set (once unleased); materialised fetch
 * objects are deleted an hour after their last lease; packs maintenance
 * began but never finished are removed after a day. The clock is the
 * test's.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
type Clock = { now: number };

function clocked(probe: GitStoreProbeDO, clock: Clock): RepoGitStorage {
  return new RepoGitStorage({
    storage: probe.git.context.storage,
    bucket: env.GIT,
    bucketName: "fyrden-git-test",
    now: () => clock.now,
  });
}

/** A pack row in `state` with its pack (and index) in R2. */
async function packIn(
  git: RepoGitStorage,
  state: string,
  kind = "receive",
  extra: { createdAt?: number; uploadId?: string } = {},
): Promise<PackId> {
  const packId = newPackId(git.context.now());
  git.registry.createPending({
    packId,
    networkId: git.networkId(),
    kind: kind as never,
    ...(extra.uploadId ? { uploadId: extra.uploadId } : {}),
  });
  const net = git.networkId();
  await env.GIT.put(packObjectKey(net, packId, "pack"), new Uint8Array([1, 2, 3]));
  await env.GIT.put(packObjectKey(net, packId, "idx"), new Uint8Array([4]));
  git.context.storage.sql
    .exec(
      `UPDATE packs SET state = ?, bytes = 3, created_at = coalesce(?, created_at),
         superseded_at = CASE WHEN ? = 'superseded' THEN ? ELSE NULL END WHERE pack_id = ?`,
      state,
      extra.createdAt ?? null,
      state,
      git.context.now(),
      packId,
    )
    .toArray();
  return packId;
}

async function retire(git: RepoGitStorage) {
  git.jobs.ensure("retire_packs", RETIRE_JOB_ID);
  const handler = packRetireHandler(git);
  for (let i = 0; i < 20; i++) {
    const ran = await git.jobs.runJob(RETIRE_JOB_ID, handler, git.memory, 0);
    if (ran.state !== "queued" || git.jobs.get(RETIRE_JOB_ID)?.cursor === null) break;
  }
}

const state = (git: RepoGitStorage, packId: string) => git.registry.get(packId)?.state;
const exists = async (key: string) => (await env.GIT.head(key)) !== null;

describe("pack retire job", () => {
  it("condemns superseded packs at once and deletes them 30 days after they were superseded", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const { old, live } = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      return { old: await packIn(git, "superseded"), live: await packIn(git, "live") };
    });
    await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      await retire(git);
      expect(state(git, old)).toBe("condemned");
      expect(git.leases.grant("read", [old], "late", 60_000)).toMatchObject({
        ok: false,
        reason: "condemned",
      });
      clock.now += 30 * DAY - HOUR;
      await retire(git);
      expect(state(git, old)).toBe("condemned");
      clock.now += 2 * HOUR;
      await retire(git);
      expect(state(git, old)).toBeUndefined();
      expect(state(git, live)).toBe("live");
    });
    expect(await exists(packObjectKey(networkId, old, "pack"))).toBe(false);
    expect(await exists(packObjectKey(networkId, old, "idx"))).toBe(false);
    expect(await exists(packObjectKey(networkId, live, "pack"))).toBe(true);
  });

  it("deletes a materialised fetch object an hour after its last lease, never while leased", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const key = "c".repeat(40);
    const packId = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      const writer = git.fetchObjects.begin(key);
      await writer.write(new Uint8Array([9, 9]));
      return (await writer.finish()).packId;
    });
    await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      // Leased by a clone that keeps it for two hours.
      const lease = git.leases.grant("read", [packId], "clone", 2 * HOUR);
      if (!lease.ok) throw new Error("not leased");
      clock.now += 90 * 60_000;
      await retire(git);
      expect(state(git, packId)).toBe("indexing");
      // The clone ends: its release is the last touch.
      clock.now += 20 * 60_000;
      git.leases.release(lease.leaseId);
      clock.now += 50 * 60_000;
      await retire(git);
      expect(state(git, packId)).toBe("indexing");
      expect(await git.fetchObjects.find(key)).toBeDefined();
      clock.now += 11 * 60_000;
      await retire(git);
      expect(state(git, packId)).toBeUndefined();
      expect(await git.fetchObjects.find(key)).toBeUndefined();
    });
    expect(await exists(fetchObjectKey(networkId, key, packId))).toBe(false);
  });

  it("removes a pack maintenance left unfinished (a crashed merge) after a day, unless it is leased or its upload is open", async () => {
    const { stub, networkId } = await newProbe();
    const clock: Clock = { now: Date.now() };
    const ids = await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      const crashed = await packIn(git, "indexing", "compact");
      const leased = await packIn(git, "indexing", "gc");
      const young = await packIn(git, "indexing", "compact", { createdAt: clock.now + 12 * HOUR });
      const upload = git.uploads.begin({
        networkId: git.networkId(),
        principal: "usr_x",
        grantId: null,
        tokenId: null,
        commands: [],
        atomic: true,
        withPack: false,
        ttlMs: 7 * DAY,
        leaseTtlMs: 60_000,
      });
      const merging = await packIn(git, "indexing", "compact", { uploadId: upload.uploadId });
      const lease = git.leases.grant("maintenance", [leased], "gc", 3 * DAY);
      if (!lease.ok) throw new Error("not leased");
      return { crashed, leased, young, merging };
    });
    await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      clock.now += DAY + HOUR;
      await retire(git);
      expect(state(git, ids.crashed)).toBeUndefined();
      expect(state(git, ids.leased)).toBe("indexing");
      expect(state(git, ids.young)).toBe("indexing");
      expect(state(git, ids.merging)).toBe("indexing");
    });
    expect(await exists(packObjectKey(networkId, ids.crashed, "pack"))).toBe(false);
    expect(await exists(packObjectKey(networkId, ids.young, "pack"))).toBe(true);
  });

  it("finishes when nothing is left, and schedules the next pass for the earliest due pack", async () => {
    const { stub } = await newProbe();
    const clock: Clock = { now: Date.now() };
    await inProbe(stub, async (probe) => {
      const git = clocked(probe, clock);
      await retire(git);
      expect(git.jobs.get(RETIRE_JOB_ID)?.state).toBe("done");
      await packIn(git, "superseded");
      await retire(git);
      const row = git.context.storage.sql
        .exec<{ state: string; at: number }>(
          "SELECT state, next_run_at AS at FROM jobs WHERE job_id = ?",
          RETIRE_JOB_ID,
        )
        .one();
      expect(row.state).toBe("queued");
      expect(row.at).toBe(clock.now + 30 * DAY);
    });
  });
});
