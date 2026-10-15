// The network collection is fenced against fork creation:
// while its mark phase runs, a fork waits (then gets a retryable refusal),
// and the mark does not start while a fork is joining,
// so no epoch decides what is unclaimed from a snapshot a new fork has
// already outdated. The ordering scenario: the parent force-pushed
// past X, a fork is created from a member that still has X while a mark is
// in progress, and X survives.

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { NETWORK_DEFAULTS } from "../src/network/runtime.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { DAY, moveRef } from "./helpers/gc.js";
import { createRepo, type TestRepo } from "./helpers/git-http.js";
import { advance, runJob, setPolicy } from "./helpers/maintenance.js";
import {
  advanceNetwork,
  cloneObjects,
  fork,
  inNetwork,
  type Owner,
  runNetworkJob,
} from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
// biome-ignore lint/style/noRestrictedImports: the waits give a fork that wrongly skipped the fence time to finish while the mark is held; a slow runner can only let it pass, never fail it falsely.
import { inRepo, signal, sleep } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const CLOCK_AHEAD = 100 * 365 * DAY;

let owner: Owner;
beforeAll(async () => {
  owner = await principalWithToken("user", "git");
});

/** P (the GC fixture, one pack) and its fork F0, with every clock ahead (only the test runs jobs). */
async function network(): Promise<{ p: TestRepo; f0: TestRepo; networkId: string }> {
  const p = await createRepo(owner.principalId);
  await loadFixture(p.stub, fx.repo, { allReachable: false });
  const { repo: f0 } = await fork(owner, p, owner);
  const networkId = await inRepo(p.stub, ({ git }) => git.networkId());
  await setPolicy(p.stub);
  await setPolicy(f0.stub);
  await advanceNetwork(networkId, CLOCK_AHEAD);
  return { p, f0, networkId };
}

/** Pauses the collection when it is about to snapshot its first member. */
async function pauseMark(networkId: string) {
  const entered = signal();
  const release = signal();
  await inNetwork(networkId, (n) => {
    n.hooks = {
      onMarkMember: async () => {
        entered.open();
        await release.wait(20_000);
      },
    };
  });
  return { entered, release };
}

const tracked = <T>(promise: Promise<T>) => {
  const state = { done: false, value: undefined as T | undefined, error: undefined as unknown };
  const settled = promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.error = error;
    },
  );
  return { state, settled };
};

describe("network collection vs fork creation", () => {
  it("a fork requested during the mark phase waits for it, then joins; nothing it borrows is condemned", async () => {
    const { f0, networkId } = await network();
    const { entered, release } = await pauseMark(networkId);
    const gc = tracked(runNetworkJob(networkId, "gc"));
    await entered.wait();
    expect((await inNetwork(networkId, (n) => n.status())).gc).toMatchObject({
      phase: "mark",
      fence: true,
    });
    const forked = tracked(fork(owner, f0, owner));
    await sleep(300);
    expect(forked.state.done).toBe(false);
    // Fork creation waits at the fence: it has not even joined yet.
    const during = await inNetwork(networkId, (n) => n.status());
    expect(during.members.some((m) => m.state === "joining")).toBe(false);
    release.open();
    await gc.settled;
    await forked.settled;
    expect(forked.state.error).toBeUndefined();
    const repo = forked.state.value?.repo as TestRepo;
    const after = await inNetwork(networkId, (n) => n.status());
    expect(after.gc).toMatchObject({ phase: "idle", fence: false, epoch: 1 });
    expect(after.deletions).toEqual([]);
    expect(after.members.find((m) => m.repoId === repo.id)?.state).toBe("active");
    for (const pack of after.packs) expect(pack.claims).toContain(repo.id);
    const clone = await cloneObjects(
      owner,
      repo,
      fx.repo.refs.map((r) => r.oid),
      ["done"],
    );
    expect(clone.objects).toEqual([...fx.repo.objects].sort());
  });

  it("when the mark outlasts the wait, fork creation is refused as retryable and leaves nothing behind", async () => {
    const { f0, networkId } = await network();
    await inNetwork(networkId, (n) => {
      n.policy = { ...NETWORK_DEFAULTS, fenceWaitMs: 100 };
    });
    const { entered, release } = await pauseMark(networkId);
    const gc = tracked(runNetworkJob(networkId, "gc"));
    await entered.wait();
    const before = await inNetwork(networkId, (n) => n.status());
    await expect(fork(owner, f0, owner)).rejects.toThrow(/network_busy/);
    const during = await inNetwork(networkId, (n) => n.status());
    expect(during.members).toEqual(before.members);
    expect(during.membershipVersion).toBe(before.membershipVersion);
    release.open();
    await gc.settled;
    // Retried after the mark, it succeeds.
    const { repo } = await fork(owner, f0, owner);
    expect(repo.id).toMatch(/^rep_/);
  });

  it("the mark does not start while a fork is joining", async () => {
    const { p, networkId } = await network();
    const seen: unknown[] = [];
    const { repo } = await fork(owner, p, owner, {
      hooks: {
        afterCopyStep: async ({ step }) => {
          if (step !== 1) return;
          seen.push(await runNetworkJob(networkId, "gc", { max: 1 }));
          seen.push((await inNetwork(networkId, (n) => n.status())).gc);
        },
      },
    });
    expect(seen[1]).toMatchObject({ phase: "idle", fence: false, epoch: 0 });
    // Once the fork has joined, the collection runs and keeps its claims.
    await inNetwork(networkId, (n) => {
      const now = n.context.now();
      n.jobs.ensure("network_gc", "network-gc", { runAt: now });
    });
    await runNetworkJob(networkId, "gc");
    const status = await inNetwork(networkId, (n) => n.status());
    expect(status.gc.epoch).toBe(1);
    for (const pack of status.packs) expect(pack.claims).toContain(repo.id);
    expect(status.deletions).toEqual([]);
  });

  it("the parent force-pushed past X; a fork of a member that still has X, created during a mark, keeps X", async () => {
    const { p, f0, networkId } = await network();
    const x = fx.f2;
    // P force-pushes feature past X and collects: its view no longer holds
    // the pack with X, and its retire job releases P's claim on it.
    await moveRef(p.stub, "refs/heads/feature", x, fx.rewritten);
    await advance(p.stub, 91 * DAY);
    await runJob(p.stub, "gc");
    await runJob(p.stub, "retire-packs");
    await advance(p.stub, 31 * DAY);
    await runJob(p.stub, "retire-packs");
    const [shared] = (await inNetwork(networkId, (n) => n.status())).packs;
    expect(shared?.claims).toEqual([f0.id]);

    // A mark starts; meanwhile F is forked from F0, whose feature is still at X.
    const { entered, release } = await pauseMark(networkId);
    const gc = tracked(runNetworkJob(networkId, "gc"));
    await entered.wait();
    const forked = tracked(fork(owner, f0, owner));
    await sleep(200);
    expect(forked.state.done).toBe(false);
    release.open();
    await gc.settled;
    await forked.settled;
    expect(forked.state.error).toBeUndefined();
    const f = forked.state.value?.repo as TestRepo;

    // X survives: claimed by F0 and F, its bytes stored, F clones it.
    await runNetworkJob(networkId, "gc");
    await advanceNetwork(networkId, 31 * DAY);
    await runNetworkJob(networkId, "delete");
    const status = await inNetwork(networkId, (n) => n.status());
    const pack = status.packs.find((s) => s.packId === shared?.packId);
    expect(pack?.state).toBe("shared");
    expect(pack?.claims.sort()).toEqual([f0.id, f.id].sort());
    expect(await env.GIT.head(`net/${networkId}/p/${shared?.packId}.pack`)).not.toBeNull();
    const clone = await cloneObjects(owner, f, [x], ["done"]);
    expect(clone.error).toBeUndefined();
    expect(clone.objects).toContain(x);
  });
});
