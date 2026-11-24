// Garbage collection keeps the commit of every CI run the repository
// records, as a re-run or a queued job needs it, after every ref and
// reflog entry that reached it is gone; it lets it go once the run is
// forgotten; and a run naming a commit the repository does not hold does
// not stop the collection.
import { env } from "cloudflare:workers";
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { DAY, expectSorted, gcRepo, minus, moveRef, objectsIn } from "./helpers/gc.js";
import { advance, runJob, setPolicy } from "./helpers/maintenance.js";
import { inRepo } from "./helpers/repo-git.js";
import { repoWithCommit } from "./helpers/runs.js";

const fx = inject("gcFixtures");
const SIDE = "refs/heads/side";

type Stub = Parameters<typeof inRepo>[0];

const recordRun = (stub: Stub, sha: string) =>
  inRepo(stub, (repo: RepoDO) => {
    const runId = newUlid();
    repo.git.context.storage.sql.exec(
      "INSERT INTO ci_runs (run_id, sha, workflow_path, created_at) VALUES (?, ?, ?, ?)",
      runId,
      sha,
      ".github/workflows/ci.yml",
      repo.git.context.now(),
    );
    return runId;
  });

const collect = async (stub: Stub) =>
  expect(["done", "scheduled"]).toContain((await runJob(stub, "gc")).state);

describe("garbage collection: CI runs' commits", () => {
  it("rescues a run's commit held only in garbage packs, with no live pack left", async () => {
    const { stub } = await gcRepo();
    for (const ref of fx.repo.refs) await moveRef(stub, ref.name, ref.oid, null);
    await advance(stub, 91 * DAY);
    await collect(stub);
    expect(await objectsIn(stub, "live")).toEqual([]);
    // A run recorded before this version, its commit collected with everything else.
    await recordRun(stub, fx.side);
    await collect(stub);
    expect(await objectsIn(stub, "live")).toContain(fx.side);
  });

  it("starts again a collection snapshotted before runs' commits were roots", async () => {
    const { stub } = await gcRepo();
    await moveRef(stub, SIDE, fx.side, null);
    await recordRun(stub, fx.side);
    await advance(stub, 91 * DAY);
    // One slice, paused while marking from the refs (before the further roots), then its cursor
    // as an earlier version wrote it.
    await setPolicy(stub, { sliceObjects: 1 });
    await runJob(stub, "gc", { max: 1 });
    await setPolicy(stub);
    const stripped = await inRepo(stub, (repo: RepoDO) => {
      const sql = repo.git.context.storage.sql;
      const [row] = sql
        .exec<{ cursor: ArrayBuffer | null }>("SELECT cursor FROM jobs WHERE job_id = 'gc'")
        .toArray();
      if (!row?.cursor) return false;
      const cursor = JSON.parse(new TextDecoder().decode(row.cursor)) as Record<string, unknown>;
      if (cursor.phase !== "mark-refs") return false;
      delete cursor.heldRoots;
      sql.exec(
        "UPDATE jobs SET cursor = ? WHERE job_id = 'gc'",
        new TextEncoder().encode(JSON.stringify(cursor)),
      );
      return true;
    });
    expect(stripped).toBe(true);
    await collect(stub);
    expectSorted(await objectsIn(stub, "live"), fx.repo.objects);
  });

  it("keeps a recorded run's commit after its branch and reflog entry are gone, until the run is forgotten", async () => {
    const { stub } = await gcRepo();
    await moveRef(stub, SIDE, fx.side, null);
    const runId = await recordRun(stub, fx.side);
    // Past the reflog retention: only the run reaches the side branch's commit.
    await advance(stub, 91 * DAY);
    await collect(stub);
    expectSorted(await objectsIn(stub, "live"), fx.repo.objects);
    await inRepo(stub, (repo: RepoDO) => {
      repo.git.context.storage.sql.exec("DELETE FROM ci_runs WHERE run_id = ?", runId);
    });
    await advance(stub, DAY);
    await collect(stub);
    expectSorted(await objectsIn(stub, "live"), fx.withoutSide);
    expectSorted(
      [...(await objectsIn(stub, "garbage")), ...(await objectsIn(stub, "condemned"))],
      minus(fx.all, fx.withoutSide),
    );
  });

  it("asks for another collection when a run is forgotten while one is under way", async () => {
    const f = await repoWithCommit();
    const stub = env.REPO.getByName(f.repo.id);
    const runId = await recordRun(stub, f.sha);
    await setPolicy(stub, { sliceObjects: 1 });
    // A collection snapshotted with the run's commit as a root, paused.
    await runJob(stub, "gc", { max: 1 });
    await setPolicy(stub);
    const after = await inRepo(stub, async (repo: RepoDO) => ({
      answer: await repo.forgetRun({ runId }),
      requested: repo.git.context.storage.sql.exec("SELECT 1 FROM collect_requests").toArray()
        .length,
    }));
    // Its forgotten commit is kept by the collection under way: the next one, asked for here,
    // lets it go once that one ends.
    expect(after).toEqual({ answer: { ok: true }, requested: 1 });
  });

  it("completes when a recorded run names a commit the repository does not hold", async () => {
    const { stub } = await gcRepo();
    await recordRun(stub, "e".repeat(40));
    await moveRef(stub, SIDE, fx.side, null);
    await advance(stub, 91 * DAY);
    await collect(stub);
    expectSorted(await objectsIn(stub, "live"), fx.withoutSide);
  });
});
