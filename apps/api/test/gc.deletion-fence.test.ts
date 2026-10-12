// Two-phase deletion of a repository's own packs: a pack is condemned
// first (no new leases), and deleted only after every lease from before the
// condemnation has expired, the deletion fence passes, and 30 days have
// passed since it left the live set, so a registry restored up to 30 days
// back still finds every pack it names. The borrowed-pack half (members of a
// fork network acknowledging) belongs to the network object; here the
// fence is this repository's own hook.
import type { PackId } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import { DAY, gcRepo, HOUR, moveRef, stored } from "./helpers/gc.js";
import { advance, packStates, runJob, setPolicy } from "./helpers/maintenance.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");

/** A repository whose three git packs were just repacked into one: three superseded packs. */
async function repacked() {
  const repo = await gcRepo(fx.packs);
  await setPolicy(repo.stub, { geometricFactor: 1000 });
  await runJob(repo.stub, "repack");
  return repo;
}

describe("deletion fence for a repository's own packs", () => {
  it("a condemned pack refuses new leases; a superseded one still grants them", async () => {
    const { stub, packIds } = await repacked();
    const before = await inRepo(stub, ({ git }) =>
      git.leases.grant("read", [packIds[0] as PackId], "early", 60_000),
    );
    expect(before.ok).toBe(true);
    await runJob(stub, "retire-packs");
    const after = await inRepo(stub, ({ git }) =>
      git.leases.grant("read", [packIds[0] as PackId], "late", 60_000),
    );
    expect(after).toMatchObject({ ok: false, reason: "condemned" });
  });

  it("deletes no superseded or garbage pack before 30 days", async () => {
    const { stub, packIds } = await repacked();
    await moveRef(stub, "refs/heads/side", fx.side, null);
    await advance(stub, 91 * DAY);
    await runJob(stub, "gc");
    await advance(stub, DAY + HOUR);
    await runJob(stub, "gc");
    const garbage = (await packStates(stub))
      .filter((p) => p.kind === "garbage")
      .map((p) => p.pack_id);
    expect(garbage.length).toBeGreaterThan(0);
    // The repack's sources left the live set 92 days ago; the garbage packs a day ago or less.
    await runJob(stub, "retire-packs");
    await inRepo(stub, async ({ git }) => {
      for (const id of packIds) expect(await stored(git, id)).toBe(false);
      for (const id of garbage) expect(await stored(git, id)).toBe(true);
    });
    await advance(stub, 29 * DAY);
    await runJob(stub, "retire-packs");
    await inRepo(stub, async ({ git }) => {
      for (const id of garbage) expect(await stored(git, id)).toBe(true);
    });
    await advance(stub, 2 * DAY);
    await runJob(stub, "retire-packs");
    await inRepo(stub, async ({ git }) => {
      for (const id of garbage) expect(await stored(git, id)).toBe(false);
    });
  });

  it("a lease from before the condemnation blocks deletion until it ends, even past 30 days", async () => {
    const { stub, packIds } = await repacked();
    const pack = packIds[1] as PackId;
    const lease = await inRepo(stub, ({ git }) =>
      git.leases.grant("read", [pack], "long clone", 10 * 60_000),
    );
    if (!lease.ok) throw new Error("not leased");
    await runJob(stub, "retire-packs");
    // The clone keeps streaming and renewing its lease (every few minutes) for 31 days.
    for (let day = 0; day < 31; day++) {
      await advance(stub, DAY);
      await inRepo(stub, ({ git }) => {
        git.context.storage.sql
          .exec(
            "UPDATE leases SET expires_at = ? WHERE lease_id = ?",
            git.context.now() + 60_000,
            lease.leaseId,
          )
          .toArray();
      });
    }
    await inRepo(stub, ({ git }) =>
      expect(git.leases.renew(lease.leaseId, 10 * 60_000)).toBeDefined(),
    );
    await runJob(stub, "retire-packs", { max: 3 });
    await inRepo(stub, async ({ git }) => {
      expect(await stored(git, pack)).toBe(true);
      expect(await stored(git, packIds[0] as PackId)).toBe(false);
    });
    await inRepo(stub, ({ git }) => git.leases.release(lease.leaseId));
    await runJob(stub, "retire-packs");
    await inRepo(stub, async ({ git }) => expect(await stored(git, pack)).toBe(false));
  });

  it("re-checks after the pause between choosing a pack and deleting it", async () => {
    const { stub, packIds } = await repacked();
    await runJob(stub, "retire-packs");
    await advance(stub, 31 * DAY);
    const seen: { packId: string; lease: unknown; stored: boolean }[] = [];
    await inRepo(stub, (repo) => {
      repo.retireOptions = {
        beforeDelete: async (packId) => {
          // During the pause: a new lease is refused, the bytes are still there.
          const { git } = repo;
          seen.push({
            packId,
            lease: git.leases.grant("read", [packId], "during the pause", 60_000),
            stored: await stored(git, packId),
          });
        },
      };
    });
    await runJob(stub, "retire-packs");
    expect(seen.map((s) => s.packId).sort()).toEqual([...packIds].sort());
    for (const s of seen) {
      expect(s.lease).toMatchObject({ ok: false, reason: "condemned" });
      expect(s.stored).toBe(true);
    }
    await inRepo(stub, async ({ git }) => {
      for (const id of packIds) expect(await stored(git, id)).toBe(false);
    });
  });

  it("deletes nothing while the fence is not acknowledged (the hook a fork network answers)", async () => {
    const { stub, packIds } = await repacked();
    await runJob(stub, "retire-packs");
    await advance(stub, 31 * DAY);
    let acknowledged = false;
    await inRepo(stub, (repo) => {
      repo.retireOptions = { fence: { acknowledged: () => acknowledged } };
    });
    await runJob(stub, "retire-packs", { max: 3 });
    await inRepo(stub, async ({ git }) => {
      for (const id of packIds) expect(await stored(git, id)).toBe(true);
    });
    acknowledged = true;
    await runJob(stub, "retire-packs");
    await inRepo(stub, async ({ git }) => {
      for (const id of packIds) expect(await stored(git, id)).toBe(false);
    });
  });

  it("a registry restored to 29 days back, across a repack and a collection, finds every pack it names", async () => {
    const { stub } = await gcRepo(fx.packs);
    await setPolicy(stub, { geometricFactor: 1000 });
    await moveRef(stub, "refs/heads/feature", fx.f2, fx.rewritten);
    await advance(stub, 91 * DAY);
    // The bookmark: every pack the registry names as readable now.
    const bookmark = (await packStates(stub))
      .filter((p) => ["live", "garbage", "superseded", "condemned"].includes(p.state))
      .map((p) => p.pack_id);
    await runJob(stub, "repack");
    await runJob(stub, "gc");
    await advance(stub, DAY + HOUR);
    await runJob(stub, "gc");
    // 29 days and an hour after the bookmark.
    await advance(stub, 28 * DAY);
    await runJob(stub, "retire-packs");
    await inRepo(stub, async ({ git }) => {
      for (const id of bookmark) expect(await stored(git, id)).toBe(true);
    });
    // Past the retention they go.
    await advance(stub, 2 * DAY);
    await runJob(stub, "retire-packs");
    const live = (await packStates(stub)).filter((p) => p.state === "live").map((p) => p.pack_id);
    await inRepo(stub, async ({ git }) => {
      for (const id of bookmark) expect(await stored(git, id)).toBe(live.includes(id));
    });
  });
});
