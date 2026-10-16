// The network's jobs keep within an invocation's budget of internal calls
// (Free allows 1,000): every slice of the collection and of the deletions
// makes at most `sliceCalls` calls, saving its place, and the alarm is a
// measured invocation, so its job queue stops starting slices once the
// calls are nearly spent.

import { env } from "cloudflare:workers";
import {
  createDoMemoryBudget,
  DEFAULT_JOB_POLICY,
  JobQueue,
  newPackId,
} from "@fyrden/adapters-cloudflare/git";
import { currentInvocation, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { NetworkDO } from "../src/do/NetworkDO.js";
import { deletionHandler } from "../src/network/deletion.js";
import { networkGcHandler } from "../src/network/gc.js";
import {
  NETWORK_DEFAULTS,
  NETWORK_DELETE_JOB_ID,
  NETWORK_GC_JOB_ID,
  type NetworkPolicy,
} from "../src/network/runtime.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { DAY } from "./helpers/gc.js";
import { createRepo, type TestRepo } from "./helpers/git-http.js";
import { setPolicy } from "./helpers/maintenance.js";
import { advanceNetwork, fork, inNetwork, type Owner } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const CLOCK_AHEAD = 100 * 365 * DAY;

let owner: Owner;
beforeAll(async () => {
  owner = await principalWithToken("user", "git");
});

/** P (the GC fixture) and two forks, every clock far ahead (only the test runs jobs). */
async function network(): Promise<{ p: TestRepo; forks: TestRepo[]; networkId: string }> {
  const p = await createRepo(owner.principalId);
  await loadFixture(p.stub, fx.repo);
  const forks = [(await fork(owner, p, owner)).repo, (await fork(owner, p, owner)).repo];
  const networkId = await inRepo(p.stub, ({ git }) => git.networkId());
  for (const repo of [p, ...forks]) await setPolicy(repo.stub);
  await advanceNetwork(networkId, CLOCK_AHEAD);
  return { p, forks, networkId };
}

const exists = async (key: string) => (await env.GIT.head(key)) !== null;

/** `n` objects under the network's pack prefix that no registry names; their keys. */
async function putOrphans(networkId: string, n: number): Promise<string[]> {
  const keys = Array.from({ length: n }, () => `net/${networkId}/p/${newPackId()}.pack`);
  for (const key of keys) await env.GIT.put(key, new Uint8Array([1]));
  return keys;
}

/** Every object under the network's pack prefix. */
async function storedKeys(networkId: string): Promise<string[]> {
  const listed = await env.GIT.list({ prefix: `net/${networkId}/p/` });
  return listed.objects.map((o) => o.key);
}

const setNetworkPolicy = (networkId: string, policy: Partial<NetworkPolicy>) =>
  inNetwork(networkId, (n) => {
    n.policy = { ...NETWORK_DEFAULTS, ...policy };
  });

/**
 * Runs one slice of a network job (queued first if it is not) as one
 * measured invocation: the internal calls it made and where the job stands.
 */
function slice(networkId: string, job: "gc" | "delete") {
  return inNetwork(networkId, (n) =>
    measureInvocation(n.context.metrics, { where: "do", op: "test" }, async () => {
      const jobId = job === "gc" ? NETWORK_GC_JOB_ID : NETWORK_DELETE_JOB_ID;
      const current = n.jobs.get(jobId);
      if (!current || current.state === "done")
        n.jobs.ensure(job === "gc" ? "network_gc" : "network_delete", jobId);
      const handler = job === "gc" ? networkGcHandler(n.runtime) : deletionHandler(n.runtime);
      await n.jobs.runJob(jobId, handler, createDoMemoryBudget(16 * 1024 * 1024), 0);
      return {
        calls: currentInvocation()?.tally.internal ?? 0,
        state: n.jobs.get(jobId)?.state,
        due: dueAt(n, jobId) <= n.context.now(),
        phase: n.registry.gcState().phase,
      };
    }),
  );
}

/** When the job `jobId` runs next. */
const dueAt = (n: NetworkDO, jobId: string): number =>
  n.context.storage.sql
    .exec<{ at: number }>("SELECT next_run_at AS at FROM jobs WHERE job_id = ?", jobId)
    .one().at;

/** Holds the network object's clock at `at`. */
const holdClock = (n: NetworkDO, at: number) => {
  (n.context as { now: () => number }).now = () => at;
};

describe("network collection within a call budget", () => {
  it("each slice makes at most its calls; the sweep resumes where it stopped and keeps every registered pack", async () => {
    const { p, forks, networkId } = await network();
    // A pack only the last fork's registry names, and objects no registry names.
    const own = await inRepo(forks[1]?.stub as TestRepo["stub"], async ({ git }) => {
      const writer = git.packStore.beginPack();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.finish();
      return writer.packId;
    });
    const orphans = await putOrphans(networkId, 3);
    const kept = (await storedKeys(networkId)).filter((key) => !orphans.includes(key));
    expect(kept).toContain(`net/${networkId}/p/${own}.pack`);
    await setNetworkPolicy(networkId, { sliceCalls: 2, sweepListLimit: 2 });
    await inNetwork(networkId, (n) => n.startGc());

    const phases: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ran = await slice(networkId, "gc");
      expect(ran.calls).toBeLessThanOrEqual(2);
      phases.push(ran.phase);
      // Nothing a registry names is deleted, whatever the sweep's progress.
      for (const key of kept) expect(await exists(key)).toBe(true);
      if (!ran.due) break;
    }
    // One member asked per slice (a call and its directory check), so the
    // mark took a slice per member, and the sweep went on across slices.
    expect(phases.filter((phase) => phase === "mark").length).toBeGreaterThanOrEqual(2);
    expect(phases.length).toBeGreaterThan(6);
    const status = await inNetwork(networkId, (n) => n.status());
    expect(status.gc).toMatchObject({ phase: "idle", fence: false, epoch: 1 });
    for (const key of orphans) expect(await exists(key)).toBe(false);
    for (const key of kept) expect(await exists(key)).toBe(true);
    expect(status.members.map((m) => m.repoId).sort()).toEqual(
      [p.id, ...forks.map((f) => f.id)].sort(),
    );
  });

  it("acknowledgements are asked within the budget, and an unreachable member once a pass", async () => {
    const { p, forks, networkId } = await network();
    const packs = [newPackId(), newPackId()];
    for (const id of packs) await env.GIT.put(`net/${networkId}/p/${id}.pack`, new Uint8Array([1]));
    const unreachable = forks[0]?.id as string;
    const asked: string[] = [];
    await inNetwork(networkId, (n) => {
      n.policy = { ...NETWORK_DEFAULTS, sliceCalls: 2 };
      n.hooks = {
        beforeAck: (repoId) => {
          asked.push(repoId);
          if (repoId === unreachable) throw new Error("member unreachable");
        },
      };
      n.registry.share(
        packs.map((packId) => ({
          packId,
          networkId,
          r2Key: "",
          kind: "",
          origin: "own" as const,
          bytes: 1,
          objectCount: null,
          unitId: null,
          createdAt: 0,
        })),
        () => p.id,
        [],
      );
      n.registry.condemn(packs, n.policy.retentionMs);
    });
    await advanceNetwork(networkId, 31 * DAY);

    let slices = 0;
    for (; slices < 20; slices++) {
      const ran = await slice(networkId, "delete");
      expect(ran.calls).toBeLessThanOrEqual(2);
      if (!ran.due) break;
    }
    // Three members and two packs: six asks, two a slice, the unreachable one asked once a pack.
    expect(slices).toBeGreaterThanOrEqual(2);
    expect(asked.filter((id) => id === unreachable)).toHaveLength(2);
    expect(asked).toHaveLength(6);
    const status = await inNetwork(networkId, (n) => n.status());
    for (const d of status.deletions) expect(d.acksPending).toEqual([unreachable]);
    for (const id of packs) expect(await exists(`net/${networkId}/p/${id}.pack`)).toBe(true);

    // It answers on the next pass: the packs go.
    await inNetwork(networkId, (n) => {
      n.hooks = {};
      holdClock(n, dueAt(n, NETWORK_DELETE_JOB_ID));
    });
    for (let i = 0; i < 20; i++) if (!(await slice(networkId, "delete")).due) break;
    expect((await inNetwork(networkId, (n) => n.status())).deletions).toEqual([]);
    for (const id of packs) expect(await exists(`net/${networkId}/p/${id}.pack`)).toBe(false);
  });

  it("the alarm counts its calls: its job queue stops starting slices once they are nearly spent", async () => {
    const { networkId } = await network();
    // The sweep asks every member about them.
    const orphans = await putOrphans(networkId, 3);
    const budget = 3;
    const alarm = () =>
      inNetwork(networkId, async (n) => {
        Object.assign(n, {
          jobs: new JobQueue(n.context, () => {}, {
            ...DEFAULT_JOB_POLICY,
            maxInternalCalls: budget,
          }),
        });
        await n.alarm();
        return n.registry.gcState();
      });
    await setNetworkPolicy(networkId, { sliceCalls: 2 });
    await inNetwork(networkId, (n) => n.startGc());
    const first = await alarm();
    // Stopped with the collection unfinished, the rest left for the next alarms.
    expect(first.epoch).toBe(1);
    expect(first.phase).not.toBe("idle");
    let gc = first;
    for (let i = 0; i < 20 && gc.phase !== "idle"; i++) gc = await alarm();
    expect(gc).toMatchObject({ epoch: 1, phase: "idle", fence: false });
    for (const key of orphans) expect(await exists(key)).toBe(false);
  });
});
