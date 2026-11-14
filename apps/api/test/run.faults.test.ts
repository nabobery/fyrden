// A run's background work never ends in a silent give-up: a repository
// outage backs off and loses nothing, work that exhausts its attempts marks
// the run and the sweep keeps retrying it until it succeeds, a reset after
// a repository call repeats the call harmlessly, a duplicate alarm makes
// one transition, a repository gone for good erases the run, and the
// runner protocol's hooks catch up with changes made while they ran.
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  assignNamed,
  at,
  checksOf,
  drain,
  finish,
  inRun,
  job,
  now,
  repoWithCommit,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";

const MIN = 60_000;
const one = workflow(job("a"));

/** Makes every repository call of the run throw `message` while `failing()` holds. */
async function failRepo(runId: string, failing: () => boolean, message = "outage") {
  await inRun(runId, (r) => {
    r.hooks = {
      beforeRepoCall: () => {
        if (failing()) throw new Error(message);
      },
    };
  });
}

describe("faults", () => {
  it("backs off through a repository outage and loses nothing", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, one);
    let down = true;
    await failRepo(runId, () => down);
    await advance(runId, 2_000);
    await advance(runId, 2_000);
    expect((await checksOf(f)).size).toBe(0);
    down = false;
    await advance(runId, 10_000);
    expect((await checksOf(f)).get("a")?.status).toBe("queued");
    expect((await runStub(runId).get())?.faults).toEqual([]);
  });

  it("marks the run when work exhausts its attempts, and the sweep retries until it succeeds", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, one);
    let down = true;
    await failRepo(runId, () => down);
    // Ten attempts with doubling backoff from 1 s: about 8.5 minutes.
    for (let i = 0; i < 12; i++) await advance(runId, 5 * MIN);
    const view = await runStub(runId).get();
    expect(view?.faults).toEqual([
      expect.objectContaining({ kind: "run_checks", error: "outage", count: 1 }),
    ]);
    expect(await inRun(runId, (r) => r.jobs.get("checks")?.state)).toBe("failed");
    down = false;
    await advance(runId, 30 * MIN);
    expect((await runStub(runId).get())?.faults).toEqual([]);
    expect((await checksOf(f)).get("a")?.status).toBe("queued");
  });

  it("writes nothing after an erase that landed while the exhausting attempt was in flight", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, one);
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = {
        beforeRepoCall: async () => {
          calls++;
          if (calls === 10) await r.erase();
          throw new Error("outage");
        },
      };
    });
    for (let i = 0; i < 12; i++) await advance(runId, 5 * MIN);
    expect(calls).toBe(10);
    const left = await inRun(runId, (r) => ({
      faults: r.engine.rows("SELECT * FROM run_faults").length,
      jobs: r.engine.rows("SELECT * FROM jobs").length,
      erased: r.engine.rows("SELECT * FROM run_erasure").length,
    }));
    expect(left).toEqual({ faults: 0, jobs: 0, erased: 1 });
  });

  it("force-cancels and self-erases when the stored workflow no longer loads", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow([job("a"), job("b", ["needs: a"])].join("\n")));
    const task = await assignNamed(runId, "a");
    await inRun(runId, (r) => {
      r.engine.exec("UPDATE runs SET workflow_source = 'jobs: [' WHERE id = 1");
    });
    expect(await runStub(runId).cancel(f.owner.principalId, "force")).toEqual({ ok: true });
    expect(await runStub(runId).updateTask(task)).toEqual({ ok: false, code: "task_finished" });
    expect((await runStub(runId).listJobs())?.jobs.map((j) => [j.name, j.conclusion])).toEqual([
      ["a", "cancelled"],
      ["b", "cancelled"],
    ]);
    await drain(runId);
    expect(await runStub(runId).get()).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    await failRepo(runId, () => true, "repo_not_found: the repository was deleted");
    await advance(runId, 2_000);
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM run_erasure").length)).toBe(1);
  });

  it("repeats a repository call harmlessly after a reset that lost its answer", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, one);
    let lost = true;
    await inRun(runId, (r) => {
      r.hooks = {
        afterRepoCall: (op) => {
          if (op === "startCheckAttempts" && lost) {
            lost = false;
            throw new Error("reset before the answer was recorded");
          }
        },
      };
    });
    await advance(runId, 2_000);
    await advance(runId, 5_000);
    const rows = await inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) =>
      r.git.context.storage.sql.exec("SELECT attempt FROM check_attempts").toArray(),
    );
    expect(rows).toEqual([{ attempt: 1 }]);
    expect((await checksOf(f)).get("a")).toMatchObject({ attempt: 1, status: "queued" });
  });

  it("survives an eviction between a transition and its alarm", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow([job("a"), job("b", ["needs: a"])].join("\n")));
    const task = await assignNamed(runId, "a");
    await runStub(runId).completeTask(task, { result: "success", logComplete: true });
    await evictDurableObject(runStub(runId));
    await at(runId, now(runId));
    await drain(runId);
    expect((await runStub(runId).listJobs())?.jobs.map((j) => [j.name, j.status])).toEqual([
      ["a", "completed"],
      ["b", "queued"],
    ]);
  });

  it("makes one transition from a duplicate alarm", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a", ["timeout-minutes: 1"])));
    await assignNamed(runId, "a");
    await at(runId, now(runId) + MIN);
    await inRun(runId, (r) => Promise.all([r.alarm(), r.alarm()]));
    await drain(runId);
    const rows = await inRun(runId, (r) =>
      r.engine.rows<{ status: string; cancel_reason: string }>(
        "SELECT status, cancel_reason FROM run_instances",
      ),
    );
    expect(rows).toEqual([{ status: "cancelling", cancel_reason: "timeout" }]);
  });

  it("cancels and erases the run when its repository is gone for good", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, one);
    await failRepo(runId, () => true, "repo_not_found: the repository was deleted");
    await advance(runId, 2_000);
    expect(await runStub(runId).get()).toBeUndefined();
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM run_erasure").length)).toBe(1);
  });
});

describe("the runner protocol's hooks", () => {
  it("bump the queue revision and task ends, and their watermarks catch up", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow([job("a"), job("b", ["needs: a"])].join("\n")));
    const before = await inRun(runId, (r) => r.engine.run());
    expect(before?.queue_rev).toBeGreaterThan(0);
    expect(before?.queue_synced_rev).toBe(before?.queue_rev);
    await finish(runId, "a");
    const after = await inRun(runId, (r) => r.engine.run());
    expect(after?.task_end_seq).toBe(1);
    expect(after?.task_end_acked).toBe(1);
    expect(after?.queue_synced_rev).toBe(after?.queue_rev);
    const ended = await inRun(runId, (r) =>
      r.engine.rows<{ task_end_seq: number; completed_at: number }>(
        "SELECT task_end_seq, completed_at FROM run_instances WHERE task_end_seq IS NOT NULL",
      ),
    );
    expect(ended).toEqual([{ task_end_seq: 1, completed_at: now(runId) }]);
  });

  it("catch up after their watermark fell behind", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow([job("a"), job("b")].join("\n")));
    // While the dispatch slice runs, another instance leaves the queue.
    await inRun(runId, (r) => {
      r.engine.exec("UPDATE runs SET queue_synced_rev = 0 WHERE id = 1");
    });
    const task = await assignNamed(runId, "a");
    void task;
    await drain(runId);
    const run = await inRun(runId, (r) => r.engine.run());
    expect(run?.queue_synced_rev).toBe(run?.queue_rev);
  });
});
