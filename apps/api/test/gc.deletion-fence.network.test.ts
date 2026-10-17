// Two-phase deletion of a fork network's shared packs (the borrowed-pack
// half of the deletion fence; the own-pack half is gc.deletion-fence.test.ts).
// The network object is the lifetime authority of shared packs: a pack no
// member claims is condemned, every member must acknowledge it (its row
// condemned, no new leases, its leases reported) before deletion, and the
// bytes go only after those leases end and the 30-day retention passes,
// re-checked after a pause between the decision and the deletion.

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { liveViewPacks } from "../src/network/member.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { DAY } from "./helpers/gc.js";
import { createRepo, type TestRepo } from "./helpers/git-http.js";
import { advance, runJob, setPolicy } from "./helpers/maintenance.js";
import {
  advanceNetwork,
  fork,
  inNetwork,
  type Owner,
  runDetach,
  runNetworkJob,
} from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const CLOCK_AHEAD = 100 * 365 * DAY;

let owner: Owner;
beforeAll(async () => {
  owner = await principalWithToken("user", "git");
});

async function stored(networkId: string, packId: string): Promise<boolean> {
  const [pack, idx] = await Promise.all([
    env.GIT.head(`net/${networkId}/p/${packId}.pack`),
    env.GIT.head(`net/${networkId}/p/${packId}.idx`),
  ]);
  return pack !== null && idx !== null;
}

/** P (three packs) and its fork F sharing them. */
async function sharedNetwork(): Promise<{
  p: TestRepo;
  f: TestRepo;
  networkId: string;
  shared: string[];
}> {
  const p = await createRepo(owner.principalId);
  const shared = await loadFixture(
    p.stub,
    { ...fx.repo, packs: fx.packs },
    { allReachable: false },
  );
  const { repo: f } = await fork(owner, p, owner);
  const networkId = await inRepo(p.stub, ({ git }) => git.networkId());
  // Every object's clock far ahead of real time: alarms never fire on their
  // own during the test, which runs each job itself.
  await setPolicy(p.stub);
  await setPolicy(f.stub);
  await advanceNetwork(networkId, CLOCK_AHEAD);
  return { p, f, networkId, shared };
}

/**
 * Both members stop reading the shared packs: F detaches (its retire job
 * releases its claims), P repacks them into one own pack (its retire job,
 * past P's retention, releases them instead of deleting them). The network
 * then condemns all three.
 */
async function releasedByAll() {
  const net = await sharedNetwork();
  const { p, f, networkId } = net;
  const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
  if (!detached.ok) throw new Error(detached.error);
  expect(await runDetach(f.stub)).toBe("done");
  await runJob(f.stub, "retire-packs");
  await setPolicy(p.stub, { geometricFactor: 1000 });
  await runJob(p.stub, "repack");
  await runJob(p.stub, "retire-packs");
  await advance(p.stub, 31 * DAY);
  await runJob(p.stub, "retire-packs");
  const status = await inNetwork(networkId, (n) => n.status());
  for (const id of net.shared) {
    expect(status.packs.find((x) => x.packId === id)).toMatchObject({
      state: "condemned",
      claims: [],
    });
    // P's own retire job did not delete them: they are shared.
    expect(await stored(networkId, id)).toBe(true);
  }
  return net;
}

describe("deletion fence for a fork network's shared packs", () => {
  it("a member that has not acknowledged blocks deletion, past the retention", async () => {
    const { p, f, networkId, shared } = await releasedByAll();
    await inNetwork(networkId, (n) => {
      n.hooks = {
        beforeAck: (repoId) => {
          if (repoId === p.id) throw new Error("member unreachable");
        },
      };
    });
    await advanceNetwork(networkId, 31 * DAY);
    expect(await runNetworkJob(networkId, "delete")).toBe("scheduled");
    const status = await inNetwork(networkId, (n) => n.status());
    for (const d of status.deletions) expect(d.acksPending).toEqual([p.id]);
    for (const id of shared) expect(await stored(networkId, id)).toBe(true);

    // The member answers: deletion proceeds.
    await inNetwork(networkId, (n) => {
      n.hooks = {};
    });
    expect(await runNetworkJob(networkId, "delete")).toBe("done");
    for (const id of shared) expect(await stored(networkId, id)).toBe(false);
    const after = await inNetwork(networkId, (n) => n.status());
    expect(after.deletions).toEqual([]);
    for (const id of shared)
      expect(after.packs.find((x) => x.packId === id)?.state).toBe("deleted");
    void f;
  });

  it("deletes nothing before the 30-day retention, even with every acknowledgement", async () => {
    const { networkId, shared } = await releasedByAll();
    expect(await runNetworkJob(networkId, "delete")).toBe("scheduled");
    const status = await inNetwork(networkId, (n) => n.status());
    for (const d of status.deletions) expect(d.acksPending).toEqual([]);
    await advanceNetwork(networkId, 29 * DAY);
    expect(await runNetworkJob(networkId, "delete")).toBe("scheduled");
    for (const id of shared) expect(await stored(networkId, id)).toBe(true);
    await advanceNetwork(networkId, 2 * DAY);
    expect(await runNetworkJob(networkId, "delete")).toBe("done");
    for (const id of shared) expect(await stored(networkId, id)).toBe(false);
  });

  it("re-checks after the pause between choosing a pack and deleting it: a claim made in the pause keeps it", async () => {
    const { p, networkId, shared } = await releasedByAll();
    const [kept] = shared as [string];
    const paused: string[] = [];
    await inNetwork(networkId, (n) => {
      n.hooks = {
        beforeDelete: (packId) => {
          paused.push(packId);
          // A restored member re-claims one pack while the deletion is paused.
          if (packId === kept) n.claim({ networkId, repoId: p.id, packIds: [kept] });
        },
      };
    });
    await advanceNetwork(networkId, 31 * DAY);
    await runNetworkJob(networkId, "delete");
    expect(paused.sort()).toEqual([...shared].sort());
    expect(await stored(networkId, kept)).toBe(true);
    for (const id of shared.filter((s) => s !== kept))
      expect(await stored(networkId, id)).toBe(false);
    const status = await inNetwork(networkId, (n) => n.status());
    expect(status.packs.find((x) => x.packId === kept)).toMatchObject({
      state: "shared",
      claims: [p.id],
    });
  });

  it("once deletion has begun, a claim does not reprieve the pack: it is reported gone, and the deletion ends", async () => {
    const { p, networkId, shared } = await releasedByAll();
    const answers: string[][] = [];
    await inNetwork(networkId, (n) => {
      n.hooks = {
        // Paused inside the deletion, after the fence and before R2 deletes the bytes.
        whileDeleting: (packId) => {
          const answer = n.claim({ networkId, repoId: p.id, packIds: [packId] });
          if (answer.ok) answers.push(answer.gone);
        },
      };
    });
    await advanceNetwork(networkId, 31 * DAY);
    expect(await runNetworkJob(networkId, "delete")).toBe("done");
    // Every claim was told the pack is gone; none was recorded or kept it.
    expect(answers.map((a) => a[0]).sort()).toEqual([...shared].sort());
    const status = await inNetwork(networkId, (n) => n.status());
    expect(status.deletions).toEqual([]);
    for (const id of shared) {
      expect(status.packs.find((x) => x.packId === id)).toMatchObject({
        state: "deleted",
        claims: [],
      });
      expect(await stored(networkId, id)).toBe(false);
    }
  });

  it("a deletion interrupted after its fence is finished on the next run, and claims meanwhile still find the pack gone", async () => {
    const { p, networkId, shared } = await releasedByAll();
    const [first] = shared as [string];
    let interrupted = false;
    await inNetwork(networkId, (n) => {
      n.hooks = {
        whileDeleting: (packId) => {
          if (packId === first && !interrupted) {
            interrupted = true;
            throw new Error("reset while deleting");
          }
        },
      };
    });
    await advanceNetwork(networkId, 31 * DAY);
    await runNetworkJob(networkId, "delete", { max: 1 });
    expect(interrupted).toBe(true);
    // The fence survived the failed slice: a restore's claim does not take the pack back.
    expect(
      await inNetwork(networkId, (n) => n.claim({ networkId, repoId: p.id, packIds: [first] })),
    ).toMatchObject({ ok: true, gone: [first] });
    expect(
      (await inNetwork(networkId, (n) => n.status())).deletions.map((d) => d.packId),
    ).toContain(first);
    await advanceNetwork(networkId, 60_000);
    expect(await runNetworkJob(networkId, "delete")).toBe("done");
    const status = await inNetwork(networkId, (n) => n.status());
    for (const id of shared) {
      expect(status.packs.find((x) => x.packId === id)?.state).toBe("deleted");
      expect(await stored(networkId, id)).toBe(false);
    }
  });

  it("a member whose view still holds the pack refuses: the pack is reprieved and claimed again", async () => {
    const { p, f, networkId, shared } = await sharedNetwork();
    const [packId] = shared as [string];
    // Claims out of date (both released, though both views still read it).
    for (const repoId of [p.id, f.id])
      await inNetwork(networkId, (n) =>
        n.releaseClaims({ networkId, repoId, releases: [{ packId, upTo: 0 }] }),
      );
    expect(
      (await inNetwork(networkId, (n) => n.status())).packs.find((x) => x.packId === packId)?.state,
    ).toBe("condemned");
    await advanceNetwork(networkId, 31 * DAY);
    await runNetworkJob(networkId, "delete");
    const status = await inNetwork(networkId, (n) => n.status());
    const pack = status.packs.find((x) => x.packId === packId);
    expect(pack?.state).toBe("shared");
    expect(pack?.claims.length).toBe(1);
    expect(status.deletions).toEqual([]);
    expect(await stored(networkId, packId)).toBe(true);
  });

  /** The claim sequence `repo` has learnt of the network. */
  const learnt = (repo: TestRepo, networkId: string) =>
    inRepo(
      repo.stub,
      ({ git }) =>
        git.context.storage.sql
          .exec<{ seq: number }>(
            "SELECT claim_seq AS seq FROM networks WHERE network_id = ?",
            networkId,
          )
          .toArray()[0]?.seq ?? 0,
    );

  it("a refusal's claim is made at a sequence the member learns: only a release it records after drops it", async () => {
    const { p, f, networkId, shared } = await sharedNetwork();
    const [packId] = shared as [string];
    const before = { [p.id]: await learnt(p, networkId), [f.id]: await learnt(f, networkId) };
    for (const repoId of [p.id, f.id])
      await inNetwork(networkId, (n) =>
        n.releaseClaims({ networkId, repoId, releases: [{ packId, upTo: 0 }] }),
      );
    await advanceNetwork(networkId, 31 * DAY);
    await runNetworkJob(networkId, "delete");
    const claims = async () =>
      (await inNetwork(networkId, (n) => n.status())).packs.find((x) => x.packId === packId)
        ?.claims;
    const [refused] = (await claims()) ?? [];
    const member = refused === p.id ? p : f;
    if (!refused) throw new Error("no member refused");
    // A release the member recorded before its refusal (told late) leaves the claim.
    const release = (upTo: number) =>
      inNetwork(networkId, (n) =>
        n.releaseClaims({ networkId, repoId: refused, releases: [{ packId, upTo }] }),
      );
    await release(before[refused] ?? 0);
    expect(await claims()).toEqual([refused]);
    // One it records after (bounded by what it learnt with the refusal) drops it.
    const after = await learnt(member, networkId);
    expect(after).toBeGreaterThan(before[refused] ?? 0);
    await release(after);
    expect(await claims()).toEqual([]);
  });

  it("a collection's claims are made at a sequence each member learns as it reports its view", async () => {
    const { p, f, networkId, shared } = await sharedNetwork();
    const [packId] = shared as [string];
    const before = await learnt(f, networkId);
    // F's claim gone (as a restore of the network object loses it), though its view holds the pack.
    await inNetwork(networkId, (n) =>
      n.releaseClaims({ networkId, repoId: f.id, releases: [{ packId, upTo: 0 }] }),
    );
    expect(await runNetworkJob(networkId, "gc")).not.toBe("failed");
    const claims = async () =>
      (await inNetwork(networkId, (n) => n.status())).packs.find((x) => x.packId === packId)
        ?.claims;
    expect(await claims()).toEqual([f.id, p.id].sort());
    const release = (upTo: number) =>
      inNetwork(networkId, (n) =>
        n.releaseClaims({ networkId, repoId: f.id, releases: [{ packId, upTo }] }),
      );
    // A release F recorded before it reported its view (told late) leaves the claim.
    await release(before);
    expect(await claims()).toEqual([f.id, p.id].sort());
    // One it records after drops it.
    const after = await learnt(f, networkId);
    expect(after).toBeGreaterThan(before);
    await release(after);
    expect(await claims()).toEqual([p.id]);
  });

  it("a release told again after the member claimed the pack anew leaves the new claim", async () => {
    const { p, f, networkId, shared } = await sharedNetwork();
    const [packId] = shared as [string];
    const packs = await inRepo(p.stub, ({ git }) =>
      liveViewPacks(git).filter((pack) => pack.packId === packId),
    );
    // F shares the pack (a pull request's import from P), as its view holds it.
    const share = async () => {
      const answer = await inNetwork(networkId, (n) =>
        n.sharePacks({ networkId, writerRepoId: p.id, claimantRepoId: f.id, packs }),
      );
      if (!answer.ok) throw new Error(answer.error);
      return answer.seq;
    };
    const release = (upTo: number) =>
      inNetwork(networkId, (n) =>
        n.releaseClaims({ networkId, repoId: f.id, releases: [{ packId, upTo }] }),
      );
    const claims = async () =>
      (await inNetwork(networkId, (n) => n.status())).packs.find((x) => x.packId === packId)
        ?.claims;
    // F's view gives it up: the release is told, and told again later.
    const first = await share();
    await release(first);
    expect(await claims()).toEqual([p.id]);
    // F claims it anew before the second telling lands: the claim made since stays.
    const again = await share();
    expect(again).toBeGreaterThan(first);
    await release(first);
    expect(await claims()).toEqual([f.id, p.id].sort());
    // F's release of the new claim drops it.
    await release(again);
    expect(await claims()).toEqual([p.id]);
  });

  it("a release told late leaves a claim made after the network object was restored to before it", async () => {
    const { p, f, networkId, shared } = await sharedNetwork();
    const [packId] = shared as [string];
    const packs = await inRepo(p.stub, ({ git }) =>
      liveViewPacks(git).filter((pack) => pack.packId === packId),
    );
    const share = async () => {
      const answer = await inNetwork(networkId, (n) =>
        n.sharePacks({ networkId, writerRepoId: p.id, claimantRepoId: f.id, packs }),
      );
      if (!answer.ok) throw new Error(answer.error);
      return answer.seq;
    };
    // F shares the pack, then its view gives it up: its release names the sequence it learnt.
    const first = await share();
    // The network object is restored to a state from before that share (its sequence back with
    // it), some time later; F shares the pack again.
    await inNetwork(networkId, (n) => {
      n.context.storage.sql.exec("UPDATE network_meta SET claim_seq = 0");
    });
    await advanceNetwork(networkId, 60_000);
    const again = await share();
    expect(again).toBeGreaterThan(first);
    // F's release lands now: the claim made since the restore stays.
    await inNetwork(networkId, (n) =>
      n.releaseClaims({ networkId, repoId: f.id, releases: [{ packId, upTo: first }] }),
    );
    const status = await inNetwork(networkId, (n) => n.status());
    expect(status.packs.find((x) => x.packId === packId)?.claims).toEqual([f.id, p.id].sort());
  });

  it("an acknowledgement condemns the member's row (no new leases); its leases hold deletion back past the retention", async () => {
    const { p, f, networkId, shared } = await sharedNetwork();
    const [packId] = shared as [string];
    // A long clone streams from the pack, and goes on after F's view drops it (F detaches).
    const lease = await inRepo(f.stub, ({ git }) =>
      git.leases.grant("read", [packId as never], "long clone", 40 * DAY),
    );
    if (!lease.ok) throw new Error("not leased");
    const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    if (!detached.ok) throw new Error(detached.error);
    expect(await runDetach(f.stub)).toBe("done");
    // Claims end early (F's ahead of its retire job, which waits for the lease).
    for (const repoId of [p.id, f.id])
      await inNetwork(networkId, (n) =>
        n.releaseClaims({ networkId, repoId, releases: [{ packId, upTo: 0 }] }),
      );
    // P's view must not hold it for the deletion to go on: P repacks it away.
    await setPolicy(p.stub, { geometricFactor: 1000 });
    await runJob(p.stub, "repack");
    await runJob(p.stub, "retire-packs");
    await advanceNetwork(networkId, 31 * DAY);
    await runNetworkJob(networkId, "delete");
    const status = await inNetwork(networkId, (n) => n.status());
    const deletion = status.deletions.find((d) => d.packId === packId);
    expect(deletion?.acksPending).toEqual([]);
    expect(deletion?.leasesUntil).toBe(lease.expiresAt);
    expect(await stored(networkId, packId)).toBe(true);
    // F acknowledged: its row is condemned and refuses new leases.
    const late = await inRepo(f.stub, ({ git }) =>
      git.leases.grant("read", [packId as never], "late", 60_000),
    );
    expect(late).toMatchObject({ ok: false, reason: "condemned" });
    // Once the lease has ended, the pack goes.
    await advanceNetwork(networkId, 10 * DAY);
    await runNetworkJob(networkId, "delete");
    expect(await stored(networkId, packId)).toBe(false);
  });
});
