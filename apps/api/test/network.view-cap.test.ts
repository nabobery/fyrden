// The view cap: a repository's full view (own plus borrowed packs) stays
// within the cap. A fork of a fork inherits its parent's own and borrowed
// packs; when that would leave too little room for the fork's own packs,
// the oldest (shared base) packs are compacted into one shared pack before
// the fork is published. Caps are small here (view 4, own 2: at most 2
// borrowed packs) so a three-pack history exceeds them.

import { beforeAll, describe, expect, inject, it } from "vitest";
import type { ViewPack } from "../src/network/types.js";
import { chooseBaseCompaction } from "../src/network/view-cap.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { objectsOf } from "./helpers/gc.js";
import type { TestRepo } from "./helpers/git-http.js";
import { createRepo } from "./helpers/git-http.js";
import { runJob } from "./helpers/maintenance.js";
import { cloneObjects, fork, inNetwork, type Owner } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const caps = { viewCap: 4, ownCap: 2 };

let owner: Owner;
beforeAll(async () => {
  owner = await principalWithToken("user", "git");
});

const viewOf = (repo: TestRepo) =>
  inRepo(repo.stub, ({ git }) =>
    git.context.storage.sql
      .exec<{ pack_id: string; origin: string; state: string; kind: string }>(
        "SELECT pack_id, origin, state, kind FROM packs ORDER BY created_at, pack_id",
      )
      .toArray(),
  );

describe("view cap", () => {
  it("chooses whole units of the oldest packs, just enough to fit", () => {
    const pack = (id: string, at: number, unitId: string | null = null): ViewPack => ({
      packId: id,
      networkId: "net_x",
      r2Key: "",
      kind: "receive",
      origin: "borrowed",
      bytes: 1,
      objectCount: 1,
      unitId,
      createdAt: at,
    });
    const packs = [pack("E", 5), pack("A", 1), pack("B", 2, "u"), pack("C", 3, "u"), pack("D", 4)];
    expect(chooseBaseCompaction(packs, 5)).toEqual([]);
    // 5 packs, room for 4: the two oldest merge into one.
    expect(chooseBaseCompaction(packs, 4).map((p) => p.packId)).toEqual(["A", "B", "C"]);
    expect(chooseBaseCompaction(packs, 3).map((p) => p.packId)).toEqual(["A", "B", "C"]);
    expect(chooseBaseCompaction(packs, 2).map((p) => p.packId)).toEqual(["A", "B", "C", "D"]);
    expect(chooseBaseCompaction(packs, 1).map((p) => p.packId)).toEqual(["A", "B", "C", "D", "E"]);
    expect(() => chooseBaseCompaction(packs, 0)).toThrow(RangeError);
  });

  it("a fork of a fork that would exceed the cap gets the shared base packs compacted", async () => {
    const p = await createRepo(owner.principalId);
    await loadFixture(p.stub, { ...fx.repo, packs: fx.packs }, { allReachable: false });
    // Within the cap with the default caps (32 and 16): no compaction.
    const { repo: f1, result: r1 } = await fork(owner, p, owner);
    expect(r1.packsCompacted).toBe(0);
    expect((await viewOf(f1)).length).toBe(3);

    // F2 forks F1 under small caps: F1's three packs leave room for at most two.
    const { repo: f2, result: r2 } = await fork(owner, f1, owner, caps);
    expect(r2.packsCompacted).toBe(2);
    const view = await viewOf(f2);
    const live = view.filter((p) => p.state === "live");
    expect(live.length).toBeLessThanOrEqual(caps.viewCap - caps.ownCap);
    expect(live.every((p) => p.origin === "borrowed")).toBe(true);
    const compacted = live.find((p) => p.kind === "compact");
    expect(compacted).toBeDefined();
    // Two of F1's packs were replaced (superseded, then released by the retire job).
    const replaced = (await viewOf(f1))
      .map((p) => p.pack_id)
      .filter((id) => !live.some((l) => l.pack_id === id));
    expect(replaced.length).toBe(2);

    // The view reads exactly the objects it read before: every object of P's packs.
    const objects = await inRepo(f2.stub, async ({ git }) => {
      const all = new Set<string>();
      for (const pack of live) for (const o of await objectsOf(git, pack.pack_id)) all.add(o);
      return [...all].sort();
    });
    expect(objects).toEqual([...fx.all].sort());
    const clone = await cloneObjects(
      owner,
      f2,
      fx.repo.refs.map((r) => r.oid),
      ["done"],
    );
    expect(clone.objects).toEqual([...fx.repo.objects].sort());

    // The parents' views are unchanged.
    expect((await viewOf(f1)).every((p) => p.state === "live")).toBe(true);
    expect((await viewOf(p)).every((p) => p.state === "live")).toBe(true);

    // The network shares the compacted pack (F2 claims it); F2 releases the packs it replaced.
    const networkId = await inRepo(p.stub, ({ git }) => git.networkId());
    let status = await inNetwork(networkId, (n) => n.status());
    expect(status.packs.find((x) => x.packId === compacted?.pack_id)?.claims).toEqual([f2.id]);
    await runJob(f2.stub, "retire-packs");
    status = await inNetwork(networkId, (n) => n.status());
    for (const id of replaced)
      expect(status.packs.find((x) => x.packId === id)?.claims.sort()).toEqual(
        [p.id, f1.id].sort(),
      );
    // Only the clone's materialised fetch pack is left besides the live view.
    expect((await viewOf(f2)).filter((p) => p.state !== "live" && p.kind !== "fetch")).toEqual([]);
  });
});
