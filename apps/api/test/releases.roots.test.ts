// A published release keeps its tag's object and commit through collection
// and detach, whoever deleted the tag and whenever; refs-only flags keep
// their meaning; deleting a release lets them go, unless a run past its
// snapshot still holds them, which only the next collection corrects.
import { oidFromHex as hexToOid } from "@fyrden/git-core";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { api, json, user } from "./helpers/api.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { DAY, minus, moveRef, objectsOf as objectsFrom, objectsIn } from "./helpers/gc.js";
import { createRepo } from "./helpers/git-http.js";
import { advance, packStates, runJob, setPolicy } from "./helpers/maintenance.js";
import { fork, inNetwork, type Owner, runDetach } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { type ReleaseOut, type ReleaseRepo, releaseRepo } from "./helpers/releases.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
/** Objects only `side` reaches (not the rewrite no ref names): a ref deleted leaves them to collection. */
const sideOnly = minus(minus([...fx.all], fx.withoutSide), fx.afterForce);

const publish = (r: ReleaseRepo, tag_name: string) =>
  json<ReleaseOut>(api("POST", `${r.path}/releases`, r.owner.token, { tag_name }));

/** `side` held only by a tag, its branch and reflog gone, old enough to collect. */
async function tagOnSide(r: ReleaseRepo, tag: string) {
  await moveRef(r.stub, `refs/tags/${tag}`, null, fx.side);
  await moveRef(r.stub, "refs/heads/side", fx.side, null);
}

const expectSideLive = async (r: ReleaseRepo) => {
  const live = await objectsIn(r.stub, "live");
  for (const object of sideOnly) expect(live).toContain(object);
};

describe("collection", () => {
  it("keeps a published release's objects after its tag is deleted, and the commit stays readable", async () => {
    const r = await releaseRepo(fx.repo);
    await tagOnSide(r, "kept");
    expect((await publish(r, "kept")).status).toBe(201);
    await moveRef(r.stub, "refs/tags/kept", fx.side, null);
    await advance(r.stub, 91 * DAY);
    expect(["done", "scheduled"]).toContain((await runJob(r.stub, "gc")).state);
    await expectSideLive(r);
    const commit = await json<{ sha: string }>(
      api("GET", `${r.path}/commits/${fx.side}`, r.owner.token),
    );
    expect(commit.body.sha).toBe(fx.side);
  }, 60_000);

  it("lets them go once the release is deleted", async () => {
    const r = await releaseRepo(fx.repo);
    await tagOnSide(r, "kept");
    const made = await publish(r, "kept");
    await moveRef(r.stub, "refs/tags/kept", fx.side, null);
    await api("DELETE", `${r.path}/releases/${made.body.id}`, r.owner.token);
    await advance(r.stub, 91 * DAY);
    await runJob(r.stub, "gc");
    const live = await objectsIn(r.stub, "live");
    for (const object of sideOnly) expect(live).not.toContain(object);
  }, 60_000);

  // The window the one synchronous read closes: published and its tag deleted during the await
  // after the reflog and roots are read. Refs read after that await would hold neither.
  it("misses nothing published during the run's first await", async () => {
    const r = await releaseRepo(fx.repo);
    await tagOnSide(r, "racing");
    await advance(r.stub, 91 * DAY);
    let ran = false;
    await inRepo(r.stub, async (repo) => {
      repo.gcHooks = {
        afterSnapshot: async () => {
          if (ran) return;
          ran = true;
          const actor = { principal: r.owner.principalId, actChain: [] };
          const made = await repo.createRelease(
            { tagName: "racing", name: null, body: null, draft: false, prerelease: false },
            actor as never,
          );
          if (!made.ok) throw new Error(`not published: ${JSON.stringify(made)}`);
          const { git } = repo;
          const deleted = git.refStore.commitSync({
            addPacks: [],
            removePacks: [],
            refUpdates: [{ name: "refs/tags/racing", oldOid: hexToOid(fx.side), newOid: null }],
            expectedVersion: git.refStore.state().version,
          });
          if (!deleted.ok) throw new Error("tag not deleted");
        },
      };
    });
    await runJob(r.stub, "gc");
    expect(ran).toBe(true);
    await expectSideLive(r);
  }, 60_000);

  it("leaves a delete during a run past its snapshot to the next collection, breaking nothing", async () => {
    const r = await releaseRepo(fx.repo);
    await tagOnSide(r, "held");
    const made = await publish(r, "held");
    await moveRef(r.stub, "refs/tags/held", fx.side, null);
    await advance(r.stub, 91 * DAY);
    let deleted = false;
    const run = await runJob(r.stub, "gc", {
      between: async () => {
        if (deleted) return;
        deleted = true;
        await api("DELETE", `${r.path}/releases/${made.body.id}`, r.owner.token);
      },
    });
    expect(deleted).toBe(true);
    expect(["done", "scheduled"]).toContain(run.state);
    await expectSideLive(r);
    await advance(r.stub, 91 * DAY);
    await runJob(r.stub, "gc");
    const live = await objectsIn(r.stub, "live");
    for (const object of sideOnly) expect(live).not.toContain(object);
  }, 60_000);

  it("adds no release-only commit to what refs-only checks reach", async () => {
    const r = await releaseRepo(fx.repo);
    await tagOnSide(r, "kept");
    await publish(r, "kept");
    await moveRef(r.stub, "refs/tags/kept", fx.side, null);
    await advance(r.stub, 91 * DAY);
    await runJob(r.stub, "gc");
    await runJob(r.stub, "reachability");
    const packs = await inRepo(r.stub, ({ git }) =>
      git.context.storage.sql
        .exec<{ pack_id: string; all_reachable: number }>(
          "SELECT pack_id, all_reachable FROM packs WHERE state = 'live'",
        )
        .toArray(),
    );
    const flagged = await inRepo(r.stub, async ({ git }) => {
      const out: string[] = [];
      for (const pack of packs)
        if (pack.all_reachable === 1) out.push(...(await objectsFrom(git, pack.pack_id)));
      return out;
    });
    for (const object of sideOnly) expect(flagged).not.toContain(object);
  }, 60_000);
});

describe("a fork", () => {
  let parentOwner: Owner;
  let forkOwner: Owner;
  beforeAll(async () => {
    parentOwner = await principalWithToken("user", "git");
    forkOwner = await user();
  });

  async function forked() {
    const p = await createRepo(parentOwner.principalId);
    await loadFixture(p.stub, fx.repo, { allReachable: false });
    const { repo: f } = await fork(parentOwner, p, forkOwner);
    await setPolicy(f.stub);
    return f;
  }

  const publishOn = (f: { stub: DurableObjectStub<RepoDO> }, tag: string) =>
    inRepo(f.stub, (repo) =>
      repo.createRelease(
        { tagName: tag, name: null, body: null, draft: false, prerelease: false },
        { principal: forkOwner.principalId, actChain: [] } as never,
      ),
    );

  it("keeps its claim on a borrowed pack while a release reaches it, and gives it up after", async () => {
    const p = await createRepo(parentOwner.principalId);
    const packIds = await loadFixture(
      p.stub,
      { ...fx.repo, packs: fx.packs },
      { allReachable: false },
    );
    const rest = packIds[2] as string;
    const { repo: f } = await fork(parentOwner, p, forkOwner);
    await setPolicy(f.stub);
    const tagged = fx.repo.refs.find((r) => r.name === "refs/tags/v1")?.oid as string;
    await moveRef(f.stub, "refs/tags/kept", null, fx.f2);
    const made = await publishOn(f, "kept");
    if (!made.ok || !("release" in made)) throw new Error(`not published: ${JSON.stringify(made)}`);
    await moveRef(f.stub, "refs/tags/kept", fx.f2, null);
    await moveRef(f.stub, "refs/heads/feature", fx.f2, null);
    await moveRef(f.stub, "refs/tags/v1", tagged, null);
    await advance(f.stub, 91 * DAY);
    await runJob(f.stub, "gc");
    const state = async () => (await packStates(f.stub)).find((s) => s.pack_id === rest)?.state;
    expect(await state()).toBe("live");
    await inRepo(f.stub, (repo) =>
      repo.deleteRelease(made.release.id, {
        principal: forkOwner.principalId,
        actChain: [],
      } as never),
    );
    await runJob(f.stub, "gc");
    expect(await state()).toBe("garbage");
  }, 60_000);

  it("keeps a release commit no ref reaches through a detach, with its graph row", async () => {
    const f = await forked();
    await moveRef(f.stub, "refs/tags/kept", null, fx.side);
    await moveRef(f.stub, "refs/heads/side", fx.side, null);
    expect(await publishOn(f, "kept")).toMatchObject({ ok: true });
    await moveRef(f.stub, "refs/tags/kept", fx.side, null);
    const networkId = await inRepo(f.stub, ({ git }) => git.networkId());
    const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    expect(detached).toMatchObject({ ok: true });
    expect(await runDetach(f.stub)).toBe("done");
    const after = await inRepo(f.stub, async ({ git }) => {
      const rows = git.context.storage.sql
        .exec<{ pack_id: string; network_id: string }>(
          "SELECT pack_id, network_id FROM packs WHERE state = 'live'",
        )
        .toArray();
      const objects = new Set<string>();
      for (const row of rows) for (const o of await objectsFrom(git, row.pack_id)) objects.add(o);
      return { objects, networks: new Set(rows.map((row) => row.network_id)) };
    });
    // Its packs are the new network's alone, and they hold the commit only the release names.
    expect(after.networks.has(networkId)).toBe(false);
    expect(after.objects.has(fx.side)).toBe(true);
    const verified = await inRepo(f.stub, ({ git }) =>
      git.commitGraph.readSync([hexToOid(fx.side)], "verified"),
    );
    expect(verified[0]?.state).toBe("verified");
  }, 60_000);
});
