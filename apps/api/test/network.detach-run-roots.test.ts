// A fork detached from its network keeps the commit of every CI run it
// records, as garbage collection does, so a queued job or a re-run can
// still check it out; a run naming a commit the fork does not hold does
// not stop the detach.
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { user } from "./helpers/api.js";
import { loadFixture } from "./helpers/fetch-repo.js";
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

  /** A fork whose `side` branch is deleted: only a run could keep its commit. */
  async function sideless() {
    const p = await createRepo(parentOwner.principalId);
    await loadFixture(p.stub, fx.repo, { allReachable: false });
    const { repo: f } = await fork(parentOwner, p, forkOwner);
    await setPolicy(f.stub);
    await moveRef(f.stub, "refs/heads/side", fx.side, null);
    const networkId = await inRepo(f.stub, ({ git }) => git.networkId());
    return { f, networkId };
  }

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
          // Its commit is still reached by the side branch's reflog entry: registered.
          answers.push(
            await repo.registerRun({
              runId: newUlid(),
              sha: fx.side,
              path: ".github/workflows/ci.yml",
              reachableVia: fx.side,
            }),
          );
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
      delete cursor.heldRoots;
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
