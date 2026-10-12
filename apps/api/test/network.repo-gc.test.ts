// A fork's own collection in a fork network: borrowed packs are marked
// (reachability goes through them) but never rewritten or deleted; a
// borrowed pack nothing in the fork reaches leaves its view as garbage, is
// condemned after the garbage time to live, and its claim goes back to the
// network, which keeps it while another member claims it.

import { beforeAll, describe, expect, inject, it } from "vitest";
import { loadFixture } from "./helpers/fetch-repo.js";
import { DAY, HOUR, moveRef } from "./helpers/gc.js";
import { createRepo } from "./helpers/git-http.js";
import { advance, packStates, runJob, setPolicy } from "./helpers/maintenance.js";
import { cloneObjects, fork, inNetwork, type Owner } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const tipOf = (name: string) => fx.repo.refs.find((r) => r.name === name)?.oid as string;

let owner: Owner;
beforeAll(async () => {
  owner = await principalWithToken("user", "git");
});

describe("a fork's own collection", () => {
  it("marks through borrowed packs and never rewrites them", async () => {
    const p = await createRepo(owner.principalId);
    await loadFixture(p.stub, fx.repo, { allReachable: false });
    const { repo: f } = await fork(owner, p, owner);
    await setPolicy(f.stub);
    await moveRef(f.stub, "refs/heads/feature", fx.f2, fx.rewritten);
    await advance(f.stub, 91 * DAY);
    const before = await packStates(f.stub);
    const run = await runJob(f.stub, "gc");
    expect(["done", "scheduled"]).toContain(run.state);
    const after = await packStates(f.stub);
    // No pack was written and the borrowed pack is still live.
    expect(after.map((p) => [p.pack_id, p.state])).toEqual(before.map((p) => [p.pack_id, "live"]));
    const clone = await cloneObjects(owner, f, [tipOf("refs/heads/main")], ["done"]);
    expect(clone.error).toBeUndefined();
  });

  it("drops a borrowed pack it no longer reaches, then releases it; the parent keeps it", async () => {
    const p = await createRepo(owner.principalId);
    // Three packs: old history, newer history, and the rest (feature, the tag, the rewrite).
    const packIds = await loadFixture(
      p.stub,
      { ...fx.repo, packs: fx.packs },
      { allReachable: false },
    );
    const rest = packIds[2] as string;
    const { repo: f } = await fork(owner, p, owner);
    const networkId = await inRepo(p.stub, ({ git }) => git.networkId());
    await setPolicy(f.stub);
    // F deletes feature and the tag: nothing F's refs reach is only in `rest`.
    await moveRef(f.stub, "refs/heads/feature", fx.f2, null);
    await moveRef(f.stub, "refs/tags/v1", tipOf("refs/tags/v1"), null);
    // Past the reflog retention, the deleted refs' old values are no roots either.
    await advance(f.stub, 91 * DAY);
    await runJob(f.stub, "gc");
    let states = await packStates(f.stub);
    expect(states.find((s) => s.pack_id === rest)?.state).toBe("garbage");
    expect(states.filter((s) => s.pack_id !== rest).every((s) => s.state === "live")).toBe(true);
    expect(states.length).toBe(3);

    await advance(f.stub, DAY + HOUR);
    await runJob(f.stub, "gc");
    states = await packStates(f.stub);
    expect(states.find((s) => s.pack_id === rest)?.state).toBe("condemned");
    await runJob(f.stub, "retire-packs");
    states = await packStates(f.stub);
    expect(states.some((s) => s.pack_id === rest)).toBe(false);

    const status = await inNetwork(networkId, (n) => n.status());
    expect(status.packs.find((x) => x.packId === rest)).toMatchObject({
      state: "shared",
      claims: [p.id],
    });
    // F still clones what its refs reach.
    const clone = await cloneObjects(owner, f, [tipOf("refs/heads/main"), fx.side], ["done"]);
    expect(clone.error).toBeUndefined();
  });

  it("brings a dropped borrowed pack back when something reaches it again", async () => {
    const p = await createRepo(owner.principalId);
    const packIds = await loadFixture(
      p.stub,
      { ...fx.repo, packs: fx.packs },
      { allReachable: false },
    );
    const rest = packIds[2] as string;
    const { repo: f } = await fork(owner, p, owner);
    await setPolicy(f.stub);
    await moveRef(f.stub, "refs/heads/feature", fx.f2, null);
    await moveRef(f.stub, "refs/tags/v1", tipOf("refs/tags/v1"), null);
    await advance(f.stub, 91 * DAY);
    await runJob(f.stub, "gc");
    expect((await packStates(f.stub)).find((s) => s.pack_id === rest)?.state).toBe("garbage");
    // Within the time to live, feature comes back.
    await moveRef(f.stub, "refs/heads/feature", null, fx.f2);
    await runJob(f.stub, "gc");
    expect((await packStates(f.stub)).find((s) => s.pack_id === rest)?.state).toBe("live");
  });
});
