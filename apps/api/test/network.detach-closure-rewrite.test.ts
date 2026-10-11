// Detach is a reachable-closure rewrite, never a byte copy.
// P holds one pack git wrote: main, feature and tag v1, and the commits of
// a private fork G that reached P through a pull request
// (`refs/pull/1/head`, the fixture's `side`), plus a commit no ref names.
// F forks P: it borrows that pack, so G's private objects are in F's view
// but not in F's closure (F gets only P's branches and tags). After F
// detaches, F's packs hold exactly F's closure (what git's rev-list says
// F's refs reach) and none of G's objects; F is in its own network.

import { env } from "cloudflare:workers";
import type { PackId } from "@fyrden/git-core";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { loadFixture } from "./helpers/fetch-repo.js";
import { minus, objectsOf } from "./helpers/gc.js";
import { createRepo, type TestRepo } from "./helpers/git-http.js";
import { advance, runJob, setPolicy } from "./helpers/maintenance.js";
import { cloneObjects, fork, inNetwork, type Owner, runDetach } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const tipOf = (name: string) => fx.repo.refs.find((r) => r.name === name)?.oid as string;

/** The fixture with `side` arrived as a pull request from G rather than a branch of P. */
const withPullRequest = {
  ...fx.repo,
  refs: fx.repo.refs.map((r) =>
    r.name === "refs/heads/side" ? { ...r, name: "refs/pull/1/head" } : r,
  ),
};
/** Objects only G's pull request reaches (G's private work). */
const gOnly = minus(minus([...fx.all], fx.withoutSide), fx.afterForce);

let pOwner: Owner;
let fOwner: Owner;

beforeAll(async () => {
  pOwner = await principalWithToken("user", "git");
  fOwner = await principalWithToken("user", "git");
});

async function network(): Promise<{ p: TestRepo; f: TestRepo; networkId: string }> {
  const p = await createRepo(pOwner.principalId);
  await loadFixture(p.stub, withPullRequest, { allReachable: false });
  const { repo: f } = await fork(pOwner, p, fOwner);
  const networkId = await inRepo(p.stub, ({ git }) => git.networkId());
  return { p, f, networkId };
}

/** Every object in F's live packs, sorted, each once; and the networks those packs are stored under. */
const liveObjects = (repo: TestRepo) =>
  inRepo(repo.stub, async ({ git }) => {
    const rows = git.context.storage.sql
      .exec<{ pack_id: string; network_id: string; origin: string }>(
        "SELECT pack_id, network_id, origin FROM packs WHERE state = 'live'",
      )
      .toArray();
    const objects = new Set<string>();
    for (const row of rows) for (const o of await objectsOf(git, row.pack_id)) objects.add(o);
    return {
      objects: [...objects].sort(),
      networks: [...new Set(rows.map((r) => r.network_id))],
      origins: [...new Set(rows.map((r) => r.origin))],
      packs: rows.map((r) => r.pack_id as PackId),
    };
  });

describe("fork detach", () => {
  it("before detach, F borrows a pack holding G's private objects, but serves none of them", async () => {
    const { p, f } = await network();
    expect(gOnly.length).toBeGreaterThan(0);
    const view = await liveObjects(f);
    for (const o of gOnly) expect(view.objects).toContain(o);
    // The want check and the object check use F's own refs and commits only.
    const want = await cloneObjects(fOwner, f, [fx.side], ["done"]);
    expect(want.error).toMatch(/not our ref/);
    expect(await f.stub.objectAccess({ kind: "commit", commit: fx.side })).toEqual({ ok: false });
    expect((await p.stub.objectAccess({ kind: "commit", commit: fx.side })).ok).toBe(true);
    const clone = await cloneObjects(
      fOwner,
      f,
      [tipOf("refs/heads/main"), tipOf("refs/heads/feature"), tipOf("refs/tags/v1")],
      ["done"],
    );
    expect(clone.objects).toEqual([...fx.withoutSide].sort());
  });

  it("writes exactly F's reachable closure into F's own packs in a new network, with none of G's objects", async () => {
    const { p, f, networkId } = await network();
    const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    if (!detached.ok) throw new Error(detached.error);
    expect(await runDetach(f.stub)).toBe("done");

    const after = await liveObjects(f);
    expect(after.networks).toEqual([detached.newNetworkId]);
    expect(after.origins).toEqual(["own"]);
    expect(after.objects).toEqual([...fx.withoutSide].sort());
    for (const o of gOnly) expect(after.objects).not.toContain(o);
    // Each detached pack holds each object once, and only closure objects.
    for (const id of after.packs) {
      const objects = await inRepo(f.stub, ({ git }) => objectsOf(git, id));
      expect(new Set(objects).size).toBe(objects.length);
      for (const o of objects) expect(fx.withoutSide).toContain(o);
    }
    // The pack F borrowed was not copied: its bytes stay where they were, under P's network.
    const keys = await env.GIT.list({ prefix: `net/${detached.newNetworkId}/p/` });
    expect(keys.objects.length).toBe(after.packs.length * 2);

    // F reads only its new packs; the commit graph keeps only F's commits.
    const state = await inRepo(f.stub, ({ git }) => ({
      networkId: git.networkId(),
      old: git.context.storage.sql
        .exec<{ state: string }>("SELECT state FROM packs WHERE network_id = ?", networkId)
        .toArray()
        .map((r) => r.state),
      commits: git.context.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM commits")
        .one().n,
    }));
    expect(state.networkId).toBe(detached.newNetworkId);
    expect(state.old.every((s) => s === "superseded" || s === "condemned")).toBe(true);
    const fCommits = fx.repo.commits.filter((c) => fx.withoutSide.includes(c.oid));
    expect(state.commits).toBe(fCommits.length);

    // The directory and both networks know.
    const row = await env.DIRECTORY.prepare("SELECT network_id FROM repos WHERE id = ?")
      .bind(f.id)
      .first<{ network_id: string }>();
    expect(row?.network_id).toBe(detached.newNetworkId);
    const old = await inNetwork(networkId, (n) => n.status());
    expect(old.members.find((m) => m.repoId === f.id)?.state).toBe("detached");
    const fresh = await inNetwork(detached.newNetworkId, (n) => n.status());
    expect(fresh.members.map((m) => [m.repoId, m.state])).toEqual([[f.id, "active"]]);

    // F still clones its whole history; P is untouched.
    const clone = await cloneObjects(
      fOwner,
      f,
      [tipOf("refs/heads/main"), tipOf("refs/heads/feature"), tipOf("refs/tags/v1")],
      ["done"],
    );
    expect(clone.objects).toEqual([...fx.withoutSide].sort());
    const parentClone = await cloneObjects(pOwner, p, [tipOf("refs/heads/side")], ["done"]);
    expect(parentClone.error).toBeUndefined();

    // F's retire job gives the borrowed pack back to the old network; P still claims it.
    await runJob(f.stub, "retire-packs");
    const claims = await inNetwork(networkId, (n) => n.status());
    for (const pack of claims.packs) {
      expect(pack.claims).toEqual([p.id]);
      expect(pack.state).toBe("shared");
    }
    expect(
      await inRepo(
        f.stub,
        ({ git }) =>
          git.context.storage.sql
            .exec("SELECT 1 FROM packs WHERE network_id = ?", networkId)
            .toArray().length,
      ),
    ).toBe(0);
  });

  it("a push during the detach is caught up: the closure at the swap is complete, nothing is lost", async () => {
    const { f, networkId } = await network();
    let moved = false;
    await inRepo(f.stub, (repo) => {
      repo.detachHooks = {
        onSlice: (cursor) => {
          // Between the rewrite and the swap, feature is force-pushed to an
          // object F's first mark did not reach.
          if (cursor.phase === "swap" && !moved) {
            moved = true;
            const result = repo.git.refStore.commitSync({
              addPacks: [],
              removePacks: [],
              refUpdates: [
                {
                  name: "refs/heads/feature",
                  oldOid: hexOid(fx.f2),
                  newOid: hexOid(fx.rewritten),
                },
              ],
              expectedVersion: repo.git.refStore.state().version,
            });
            if (!result.ok) throw new Error("the concurrent ref update failed");
          }
        },
      };
    });
    const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    if (!detached.ok) throw new Error(detached.error);
    expect(await runDetach(f.stub)).toBe("done");
    expect(moved).toBe(true);
    const after = await liveObjects(f);
    expect(after.networks).toEqual([detached.newNetworkId]);
    // Two rounds: the catch-up wrote what the moved ref newly reaches. The
    // first round's pack keeps what feature reached before the push (f2,
    // still in the reflog): every object was in F's closure at some point
    // of the detach, and the closure at the swap is all there.
    expect(after.packs.length).toBe(2);
    expect(after.objects).toEqual([...new Set([...fx.afterForce, ...fx.withoutSide])].sort());
    for (const o of gOnly) expect(after.objects).not.toContain(o);
  });

  it("a failure right after the swap is recovered: the replay cleans up and notifies, once", async () => {
    const { f, networkId } = await network();
    await setPolicy(f.stub);
    let failures = 0;
    const phases: string[] = [];
    await inRepo(f.stub, (repo) => {
      repo.detachHooks = {
        onSlice: (cursor) => {
          phases.push(cursor.phase);
        },
        afterSwap: () => {
          if (failures++ === 0) throw new Error("scratch cleanup failed");
        },
      };
    });
    const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    if (!detached.ok) throw new Error(detached.error);
    let state = await runDetach(f.stub);
    for (let i = 0; i < 5 && state !== "done"; i++) {
      // The failed slice is retried after a backoff.
      await advance(f.stub, 60_000);
      state = await runDetach(f.stub);
    }
    expect(state).toBe("done");
    // The swap ran once; the replay went straight to cleanup and notification.
    expect(failures).toBe(1);
    expect(phases.filter((p) => p === "swap").length).toBe(1);
    expect(phases.at(-1)).toBe("notify");
    const after = await liveObjects(f);
    expect(after.networks).toEqual([detached.newNetworkId]);
    expect(after.objects).toEqual([...fx.withoutSide].sort());
    const row = await env.DIRECTORY.prepare("SELECT network_id FROM repos WHERE id = ?")
      .bind(f.id)
      .first<{ network_id: string }>();
    expect(row?.network_id).toBe(detached.newNetworkId);
    const old = await inNetwork(networkId, (n) => n.status());
    expect(old.members.find((m) => m.repoId === f.id)?.state).toBe("detached");
    const scratch = await env.GIT.list({ prefix: `net/${detached.newNetworkId}/scratch/` });
    expect(scratch.objects).toEqual([]);
  });

  it("verifies the closure and prunes the commit graph in slices within the slice budget", async () => {
    const { f, networkId } = await network();
    // Two objects (or commit rows) per slice: the final checks cannot finish in one.
    await setPolicy(f.stub, { sliceObjects: 2 });
    const phases: string[] = [];
    await inRepo(f.stub, (repo) => {
      repo.detachHooks = {
        onSlice: (cursor) => {
          phases.push(cursor.phase);
        },
      };
    });
    const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    if (!detached.ok) throw new Error(detached.error);
    expect(await runDetach(f.stub, 2_000)).toBe("done");
    const verify = phases.filter((p) => p === "verify").length;
    const prune = phases.filter((p) => p === "prune").length;
    expect(verify).toBeGreaterThanOrEqual(fx.withoutSide.length / 2);
    const fCommits = fx.repo.commits.filter((c) => fx.withoutSide.includes(c.oid));
    expect(prune).toBeGreaterThanOrEqual(fCommits.length / 2);
    // Still exactly the closure, and the graph keeps only F's commits.
    const after = await liveObjects(f);
    expect(after.objects).toEqual([...fx.withoutSide].sort());
    const commits = await inRepo(
      f.stub,
      ({ git }) =>
        git.context.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM commits").one().n,
    );
    expect(commits).toBe(fCommits.length);
  });

  it("a repository being detached cannot be forked, and a second detach is refused", async () => {
    const { f, networkId } = await network();
    const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    expect(detached.ok).toBe(true);
    const again = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    expect(again).toMatchObject({ ok: false, code: "bad_state" });
    const other = await principalWithToken("user", "git");
    await expect(fork(fOwner, f, other)).rejects.toThrow(/parent_detaching/);
    expect(await runDetach(f.stub)).toBe("done");
  });
});

function hexOid(hex: string) {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16)) as never;
}
