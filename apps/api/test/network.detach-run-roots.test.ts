// A fork detached from its network keeps the commit of every CI run it
// records, as garbage collection does, so a queued job or a re-run can
// still check it out; a run naming a commit the fork does not hold does
// not stop the detach.
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { oidFromHex, oidToHex } from "@fyrden/git-core";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { DetachCursor } from "../src/network/detach.js";
import { user } from "./helpers/api.js";
import { loadFixture, storeFixture } from "./helpers/fetch-repo.js";
import { moveRef, objectsOf } from "./helpers/gc.js";
import { createRepo } from "./helpers/git-http.js";
import { setPolicy } from "./helpers/maintenance.js";
import { fork, inNetwork, type Owner, runDetach } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");

describe("a fork's detach", () => {
  let parentOwner: Owner;
  let forkOwner: Owner;
  beforeAll(async () => {
    parentOwner = await principalWithToken("user", "git");
    forkOwner = await user();
  });

  /**
   * A fork whose `side` branch is deleted, its reflog entry since expired:
   * only a run could keep its commit.
   * Not `stored`: one that never had the branch, nor its last commit's object.
   */
  async function sideless({ stored = true } = {}) {
    const p = await createRepo(parentOwner.principalId);
    const isSide = (ref: { name: string }) => ref.name === "refs/heads/side";
    await loadFixture(
      p.stub,
      stored
        ? fx.repo
        : {
            ...fx.repo,
            packs: [fx.withoutSideCommitPack],
            refs: fx.repo.refs.filter((ref) => !isSide(ref)),
          },
      { allReachable: false },
    );
    const { repo: f } = await fork(parentOwner, p, forkOwner);
    await setPolicy(f.stub);
    if (stored) await moveRef(f.stub, "refs/heads/side", fx.side, null);
    await inRepo(f.stub, expireReflog);
    const networkId = await inRepo(f.stub, ({ git }) => git.networkId());
    return { f, networkId };
  }

  /** The reflog as once every entry has expired and is pruned. */
  const expireReflog = (repo: RepoDO) => {
    repo.git.context.storage.sql.exec("DELETE FROM reflog").toArray();
  };

  const recordRun = (repo: RepoDO, sha: string) =>
    repo.git.context.storage.sql.exec(
      "INSERT INTO ci_runs (run_id, sha, workflow_path, created_at) VALUES (?, ?, ?, ?)",
      newUlid(),
      sha,
      ".github/workflows/ci.yml",
      repo.git.context.now(),
    );

  const liveObjects = (f: { stub: Parameters<typeof inRepo>[0] }) =>
    inRepo(f.stub, async ({ git }) => {
      const rows = git.context.storage.sql
        .exec<{ pack_id: string }>("SELECT pack_id FROM packs WHERE state = 'live'")
        .toArray();
      const objects = new Set<string>();
      for (const row of rows) for (const o of await objectsOf(git, row.pack_id)) objects.add(o);
      return objects;
    });

  it("keeps a run recorded after the round's mark, marking again", async () => {
    const { f, networkId } = await sideless();
    await inRepo(f.stub, (repo: RepoDO) => {
      let recorded = false;
      repo.detachHooks = {
        onSlice: (cursor) => {
          if (cursor.phase !== "verify" || recorded) return;
          recorded = true;
          recordRun(repo, fx.side);
        },
      };
    });
    expect(await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }))).toMatchObject({
      ok: true,
    });
    expect(await runDetach(f.stub)).toBe("done");
    expect((await liveObjects(f)).has(fx.side)).toBe(true);
  }, 60_000);

  it("keeps a run registered after the round's checks, at its swap", async () => {
    const { f, networkId } = await sideless();
    const answers: unknown[] = [];
    await inRepo(f.stub, (repo: RepoDO) => {
      repo.detachHooks = {
        onSlice: async (cursor) => {
          if (cursor.phase !== "prune" || answers.length > 0) return;
          answers.push(await register(repo, fx.side));
        },
      };
    });
    expect(await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }))).toMatchObject({
      ok: true,
    });
    expect(await runDetach(f.stub)).toBe("done");
    expect(answers).toEqual([{ ok: true }]);
    expect((await liveObjects(f)).has(fx.side)).toBe(true);
  }, 60_000);

  /** Detaches `f`, telling `onSlice` each slice's phase; the phases it ran and its last round. */
  async function detachedWith(
    { f, networkId }: Awaited<ReturnType<typeof sideless>>,
    onSlice: (repo: RepoDO, cursor: DetachCursor) => Promise<void> | void,
  ) {
    const phases: string[] = [];
    let round = 0;
    await inRepo(f.stub, (repo: RepoDO) => {
      repo.detachHooks = {
        onSlice: async (cursor) => {
          phases.push(cursor.phase);
          round = cursor.round;
          await onSlice(repo, cursor);
        },
      };
    });
    expect(await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }))).toMatchObject({
      ok: true,
    });
    expect(await runDetach(f.stub)).toBe("done");
    return { verified: phases.filter((p) => p === "verify").length, round };
  }

  const moveSide = (repo: RepoDO, from: string | null, to: string | null) => {
    const result = repo.git.refStore.commitSync({
      addPacks: [],
      removePacks: [],
      refUpdates: [
        {
          name: "refs/heads/side",
          oldOid: from === null ? null : oidFromHex(from),
          newOid: to === null ? null : oidFromHex(to),
        },
      ],
      expectedVersion: repo.git.refStore.state().version,
    });
    if (!result.ok) throw new Error(`ref update failed: ${JSON.stringify(result)}`);
  };

  /** As a run whose record a restore dropped registers again: whatever reaches its commit now. */
  const register = (repo: RepoDO, sha: string) =>
    repo.registerRun({ runId: newUlid(), sha, path: ".github/workflows/ci.yml" });

  it("keeps the whole checkout of a run registered at its swap, its commit pushed without its tree", async () => {
    const detaching = await sideless({ stored: false });
    const answers: unknown[] = [];
    let pushed = false;
    const { round } = await detachedWith(detaching, async (repo, cursor) => {
      if (cursor.phase === "mark" && !pushed) {
        pushed = true;
        // As a push during the detach: the commit in a pack of the new network, over objects only
        // the old network's packs hold.
        expect(repo.git.networkId()).toBe(cursor.newNetworkId);
        await storeFixture(
          repo.git,
          { ...fx.repo, packs: [fx.sideCommitPack], commits: [], refs: [] },
          { allReachable: false },
        );
        moveSide(repo, null, fx.side);
        moveSide(repo, fx.side, null);
        expireReflog(repo);
      }
      if (cursor.phase === "prune" && answers.length === 0)
        answers.push(await register(repo, fx.side));
    });
    expect(answers).toEqual([{ ok: true }]);
    const live = await liveObjects(detaching.f);
    expect(fx.repo.objects.filter((o) => !live.has(o))).toEqual([]);
    expect(round).toBe(2);
  }, 60_000);

  it("verifies once more, in the same round, for a run registered late whose commit it kept", async () => {
    const detaching = await sideless();
    const parent = fx.repo.commits.find((c) => c.oid === fx.f2)?.parents[0] as string;
    const answers: unknown[] = [];
    const { verified, round } = await detachedWith(detaching, async (repo, cursor) => {
      if (cursor.phase !== "prune" || answers.length > 0) return;
      answers.push(
        await repo.registerRun({
          runId: newUlid(),
          sha: parent,
          path: ".github/workflows/ci.yml",
          reachableVia: fx.f2,
        }),
      );
    });
    expect(answers).toEqual([{ ok: true }]);
    expect({ verified, round }).toEqual({ verified: 2, round: 1 });
  }, 60_000);

  it("keeps the write freeze while it verifies once more", async () => {
    const detaching = await sideless();
    const parent = fx.repo.commits.find((c) => c.oid === fx.f2)?.parents[0] as string;
    const held: boolean[] = [];
    let registered = false;
    const { round } = await detachedWith(detaching, async (repo, cursor) => {
      // Refs that move before each swap, until the detach freezes them.
      if (cursor.phase === "swap" && !cursor.freeze)
        cursor.round % 2 === 1 ? moveSide(repo, null, fx.side) : moveSide(repo, fx.side, null);
      if (cursor.phase === "prune" && cursor.freeze && !registered) {
        registered = true;
        await repo.registerRun({
          runId: newUlid(),
          sha: parent,
          path: ".github/workflows/ci.yml",
          reachableVia: fx.f2,
        });
      }
      if (cursor.phase === "verify" && registered)
        held.push(cursor.freeze !== undefined && repo.git.locks.isHeld(cursor.freeze));
    });
    expect({ held, round }).toEqual({ held: [true], round: 4 });
  }, 60_000);

  it("swaps at once for a run registered late at a branch's tip", async () => {
    const detaching = await sideless();
    const answers: unknown[] = [];
    const { verified, round } = await detachedWith(detaching, async (repo, cursor) => {
      if (cursor.phase !== "prune" || answers.length > 0) return;
      answers.push(await register(repo, fx.f2));
    });
    expect(answers).toEqual([{ ok: true }]);
    expect({ verified, round }).toEqual({ verified: 1, round: 1 });
  }, 60_000);

  it("keeps a run's commit when the fork has no refs", async () => {
    const detaching = await sideless();
    const { f } = detaching;
    const refs = await inRepo(f.stub, ({ git }) =>
      [...git.refStore.readRefsSync().refs].map(([name, oid]) => [name, oidToHex(oid)] as const),
    );
    for (const [name, oid] of refs) await moveRef(f.stub, name, oid, null);
    await inRepo(f.stub, expireReflog);
    let recorded = false;
    await detachedWith(detaching, (repo, cursor) => {
      if (cursor.phase !== "verify" || recorded) return;
      recorded = true;
      recordRun(repo, fx.side);
    });
    expect(recorded).toBe(true);
    expect((await liveObjects(f)).has(fx.side)).toBe(true);
  }, 60_000);

  it("begins again a round an earlier version began without the runs' commits", async () => {
    const { f, networkId } = await sideless();
    // Stopped once at its prune, past its verify: then its cursor as an earlier version wrote it,
    // with a run recorded that its mark never read.
    await inRepo(f.stub, (repo: RepoDO) => {
      let stopped = false;
      repo.detachHooks = {
        onSlice: (cursor) => {
          if (cursor.phase !== "prune" || stopped) return;
          stopped = true;
          throw new Error("stopped at the prune");
        },
      };
    });
    expect(await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }))).toMatchObject({
      ok: true,
    });
    await inRepo(f.stub, async (repo: RepoDO) => {
      await repo.alarm();
    });
    const legacy = await inRepo(f.stub, (repo: RepoDO) => {
      const sql = repo.git.context.storage.sql;
      const [row] = sql
        .exec<{ cursor: ArrayBuffer | null }>("SELECT cursor FROM jobs WHERE job_id = 'detach'")
        .toArray();
      if (!row?.cursor) return "none";
      const cursor = JSON.parse(new TextDecoder().decode(row.cursor)) as Record<string, unknown>;
      if (cursor.phase !== "prune") return String(cursor.phase);
      delete cursor.rootsRound;
      // Due again now, past the failed slice's retry delay.
      sql.exec(
        "UPDATE jobs SET cursor = ?, next_run_at = ? WHERE job_id = 'detach'",
        new TextEncoder().encode(JSON.stringify(cursor)),
        repo.git.context.now(),
      );
      recordRun(repo, fx.side);
      repo.detachHooks = {};
      return "prune";
    });
    expect(legacy).toBe("prune");
    expect(await runDetach(f.stub)).toBe("done");
    expect((await liveObjects(f)).has(fx.side)).toBe(true);
  }, 60_000);

  it("keeps a run's commit no ref reaches, and skips one the fork does not hold", async () => {
    const p = await createRepo(parentOwner.principalId);
    await loadFixture(p.stub, fx.repo, { allReachable: false });
    const { repo: f } = await fork(parentOwner, p, forkOwner);
    await setPolicy(f.stub);
    await moveRef(f.stub, "refs/heads/side", fx.side, null);
    await inRepo(f.stub, (repo: RepoDO) => {
      expireReflog(repo);
      for (const sha of [fx.side, "e".repeat(40)])
        repo.git.context.storage.sql.exec(
          "INSERT INTO ci_runs (run_id, sha, workflow_path, created_at) VALUES (?, ?, ?, ?)",
          newUlid(),
          sha,
          ".github/workflows/ci.yml",
          repo.git.context.now(),
        );
    });
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
      for (const row of rows) for (const o of await objectsOf(git, row.pack_id)) objects.add(o);
      return { objects, networks: new Set(rows.map((row) => row.network_id)) };
    });
    expect(after.networks.has(networkId)).toBe(false);
    expect(after.objects.has(fx.side)).toBe(true);
  }, 60_000);
});
