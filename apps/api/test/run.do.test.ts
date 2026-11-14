// A CI run's object: created once per run id through the seam triggers
// call, its jobs decided as their needs end (a failure skipping dependents,
// `if: always()` still running), handed to runners once per key, fenced by
// task, cancelled gracefully or by force, timed out, re-run as a new
// attempt, and its checks published to the repository in batches.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { startRun } from "../src/ci/runs.js";
import type { AssignAnswer } from "../src/do/RunDO.js";
import {
  advance,
  assignNamed,
  at,
  checksOf,
  drain,
  expr,
  type Fixture,
  finish,
  inRun,
  job,
  jobNamed,
  jobsOf,
  repoWithCommit,
  runStub,
  specFor,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";

const MIN = 60_000;
const chain = workflow(
  [job("a"), job("b", ["needs: a"]), job("c", ["needs: b", "if: always()"])].join("\n"),
);

describe("creating a run", () => {
  it("is idempotent per run id and refuses another spec under the same id", async () => {
    const f = await repoWithCommit();
    const spec = specFor(f, chain);
    const first = await startRun(env, spec);
    expect(first).toMatchObject({
      ok: true,
      created: true,
      run: { attempt: 1, status: "in_progress" },
    });
    const again = await startRun(env, spec);
    expect(again).toMatchObject({ ok: true, created: false });
    const other = await runStub(spec.runId).create({ ...spec, ref: "refs/heads/other" });
    expect(other).toEqual({ ok: false, code: "run_exists" });
  });

  it("fails a workflow that does not plan, with its errors and no jobs", async () => {
    const f = await repoWithCommit();
    const spec = specFor(f, workflow(job("a", ["needs: missing"])));
    const answer = await startRun(env, spec);
    expect(answer).toMatchObject({ ok: true, run: { status: "completed", conclusion: "failure" } });
    expect((await runStub(spec.runId).get())?.errors.join(" ")).toMatch(/missing/);
    expect(await jobsOf(spec.runId)).toEqual([]);
  });

  it("is refused for a repository that does not exist", async () => {
    const f = await repoWithCommit();
    const spec = specFor({ ...f, repo: { id: "rep_missing0000", name: "x" } } as Fixture, chain);
    expect(await startRun(env, spec)).toEqual({ ok: false, code: "repo_not_found" });
  });

  it("refuses a malformed spec", async () => {
    const f = await repoWithCommit();
    const spec = { ...specFor(f, chain), actor: "nobody" };
    await expect(inRun(spec.runId, (r) => r.create(spec))).rejects.toThrow(
      /actor must be a principal id/,
    );
  });
});

describe("needs", () => {
  it("queues a job once its needs succeeded and publishes each job's check", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    expect((await jobsOf(runId)).map((j) => [j.name, j.status])).toEqual([["a", "queued"]]);
    await finish(runId, "a");
    await finish(runId, "b");
    await finish(runId, "c");
    expect(await runStub(runId).get()).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    await advance(runId, 2_000);
    const checks = await checksOf(f);
    expect([...checks.values()].map((c) => [c.name, c.status, c.conclusion])).toEqual([
      ["a", "completed", "success"],
      ["b", "completed", "success"],
      ["c", "completed", "success"],
    ]);
  });

  it("skips the dependents of a failed job, and still runs if: always()", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    await finish(runId, "a", "failure");
    expect((await jobsOf(runId)).map((j) => [j.name, j.status, j.conclusion])).toEqual([
      ["a", "completed", "failure"],
      ["b", "completed", "skipped"],
      ["c", "queued", null],
    ]);
    await finish(runId, "c");
    expect(await runStub(runId).get()).toMatchObject({ conclusion: "failure" });
    await advance(runId, 2_000);
    expect((await checksOf(f)).get("b")?.conclusion).toBe("skipped");
  });

  it("passes outputs to dependents, merged over a matrix, and expands a matrix from them", async () => {
    const f = await repoWithCommit();
    const source = workflow(
      [
        job("define", ["outputs:", `  list: ${expr("steps.s.outputs.list")}`]),
        job("build", [
          "needs: define",
          `name: build ${expr("matrix.os")}`,
          "strategy:",
          "  matrix:",
          `    os: ${expr("fromJSON(needs.define.outputs.list)")}`,
        ]),
      ].join("\n"),
    );
    const runId = await started(f, source);
    await finish(runId, "define", "success", { list: '["linux","windows"]' });
    expect((await jobsOf(runId)).map((j) => j.name)).toEqual([
      "define",
      "build linux",
      "build windows",
    ]);
    const assigned = (await runStub(runId).assign(
      (
        await jobNamed(runId, "build linux")
      ).jobId,
      "k",
    )) as AssignAnswer;
    expect(assigned).toMatchObject({
      ok: true,
      needs: { define: { result: "success", outputs: { list: '["linux","windows"]' } } },
    });
  });
});

describe("a step's work", () => {
  it("ends the step once its expression work is spent, and the next step goes on", async () => {
    const f = await repoWithCommit();
    const spec = specFor(f, workflow([job("a"), job("b"), job("c")].join("\n")));
    await at(spec.runId, T0);
    await inRun(spec.runId, (r) => {
      r.policy = { ...r.policy, stepWork: 1 };
    });
    await startRun(env, spec);
    const first = await inRun(spec.runId, (r) =>
      r.context.storage.transactionSync(() => r.engine.step()),
    );
    expect(first).toEqual({ more: true });
    expect(await jobsOf(spec.runId)).toHaveLength(1);
    await drain(spec.runId);
    expect(await jobsOf(spec.runId)).toHaveLength(3);
  });
});

describe("outputs named like object properties", () => {
  it("passes on an output named __proto__ like any other", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow([job("a"), job("b", ["needs: a"])].join("\n")));
    await finish(runId, "a", "success", JSON.parse('{"__proto__":"x","plain":"y"}'));
    const assigned = (await runStub(runId).assign(
      (
        await jobNamed(runId, "b")
      ).jobId,
      "k",
    )) as AssignAnswer;
    expect(assigned.ok && Object.entries(assigned.needs.a?.outputs ?? {})).toEqual([
      ["__proto__", "x"],
      ["plain", "y"],
    ]);
  });
});

describe("instance budget", () => {
  it("gives a skipped matrix's reservation back for a later job to expand into", async () => {
    const f = await repoWithCommit();
    const values = Array.from({ length: 250 }, (_, i) => i).join(", ");
    const source = workflow(
      [
        job("define", ["outputs:", `  list: ${expr("steps.s.outputs.list")}`]),
        job("big", ["if: false", "strategy:", "  matrix:", `    n: [${values}]`]),
        job("dyn", [
          "needs: [define, big]",
          "if: always()",
          "strategy:",
          "  matrix:",
          `    n: ${expr("fromJSON(needs.define.outputs.list)")}`,
        ]),
      ].join("\n"),
    );
    const runId = await started(f, source);
    const hundred = JSON.stringify(Array.from({ length: 100 }, (_, i) => i));
    await finish(runId, "define", "success", { list: hundred });
    const jobs = (await runStub(runId).listJobs(undefined, 0, 256))?.jobs ?? [];
    // define, big (skipped, one row), and dyn's 100 instances: 102 in all, within the run's 256.
    expect(jobs.filter((j) => j.jobKey === "dyn")).toHaveLength(100);
    expect(jobs.find((j) => j.jobKey === "big")?.conclusion).toBe("skipped");
  });
});

describe("tasks", () => {
  it("assigns once per key: a repeat writes nothing, and after completion is task_finished", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    const a = await jobNamed(runId, "a");
    const first = (await runStub(runId).assign(a.jobId, "key-1")) as AssignAnswer;
    await advance(runId, 5_000);
    const repeat = await runStub(runId).assign(a.jobId, "key-1");
    expect(repeat).toMatchObject({ ok: true, task: first.ok ? first.task : undefined });
    expect((await jobNamed(runId, "a")).startedAt).toBe(T0);
    expect(await runStub(runId).assign(a.jobId, "key-2")).toEqual({
      ok: false,
      code: "not_queued",
    });
    if (!first.ok) throw new Error("not assigned");
    await runStub(runId).completeTask(first.task, { result: "success", logComplete: true });
    expect(await runStub(runId).assign(a.jobId, "key-1")).toEqual({
      ok: false,
      code: "task_finished",
    });
  });

  it("answers the original actor as the token's principal, and returns the payload", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    const answer = (await runStub(runId).assign(
      (
        await jobNamed(runId, "a")
      ).jobId,
      "k",
    )) as AssignAnswer;
    expect(answer).toMatchObject({
      ok: true,
      repoId: f.repo.id,
      actorId: f.owner.principalId,
      triggeringActorId: f.owner.principalId,
      attempt: 1,
      timeoutMinutes: 360,
    });
    if (!answer.ok) return;
    expect(new TextDecoder().decode(answer.payload)).toContain('"a"');
  });

  it("fences a task once its instance completed", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    const task = await finish(runId, "a");
    expect(await runStub(runId).updateTask(task)).toEqual({ ok: false, code: "task_finished" });
    expect(
      await runStub(runId).completeTask(task, { result: "failure", logComplete: true }),
    ).toEqual({ ok: false, code: "task_finished" });
    expect(await runStub(runId).updateTask({ jobId: task.jobId, task: task.task + 99 })).toEqual({
      ok: false,
      code: "unknown_task",
    });
    expect(await runStub(runId).taskLive(task)).toBe(false);
  });

  it("keeps a complete log complete whoever writes after", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    const task = await assignNamed(runId, "a");
    expect(await runStub(runId).taskLive(task)).toBe(true);
    await runStub(runId).markLogComplete(task);
    await runStub(runId).completeTask(task, { result: "success", logComplete: false });
    await runStub(runId).markLogIncomplete(task);
    expect((await jobNamed(runId, "a")).logComplete).toBe(true);
  });
});

describe("cancellation", () => {
  it("cancels gracefully: queued jobs end, a running one is told to stop, always() still runs", async () => {
    const f = await repoWithCommit();
    const source = workflow(
      [job("a"), job("q"), job("cleanup", ["needs: a", "if: always()"])].join("\n"),
    );
    const runId = await started(f, source);
    const task = await assignNamed(runId, "a");
    expect(await runStub(runId).cancel(f.owner.principalId, "graceful")).toEqual({ ok: true });
    expect((await jobNamed(runId, "q")).conclusion).toBe("cancelled");
    expect(await runStub(runId).updateTask(task)).toEqual({ ok: true, cancel: true });
    await runStub(runId).completeTask(task, { result: "cancelled", logComplete: true });
    await drain(runId);
    expect((await jobNamed(runId, "cleanup")).status).toBe("queued");
    await finish(runId, "cleanup");
    expect(await runStub(runId).get()).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    expect(await runStub(runId).cancel(f.owner.principalId, "graceful")).toEqual({
      ok: false,
      code: "run_not_cancellable",
    });
  });

  it("force-cancels everything, fencing running tasks and marking their logs incomplete", async () => {
    const f = await repoWithCommit();
    const source = workflow([job("a"), job("cleanup", ["needs: a", "if: always()"])].join("\n"));
    const runId = await started(f, source);
    const task = await assignNamed(runId, "a");
    expect(await runStub(runId).cancel(f.owner.principalId, "force")).toEqual({ ok: true });
    await drain(runId);
    expect((await jobsOf(runId)).map((j) => [j.name, j.conclusion, j.logComplete])).toEqual([
      ["a", "cancelled", false],
      ["cleanup", "cancelled", null],
    ]);
    expect(await runStub(runId).updateTask(task)).toEqual({ ok: false, code: "task_finished" });
    expect(await runStub(runId).get()).toMatchObject({ conclusion: "cancelled" });
  });

  it("completes a cancelling job whose runner never answers after the grace", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    const task = await assignNamed(runId, "a");
    await runStub(runId).cancel(f.owner.principalId, "graceful");
    await advance(runId, 2 * MIN - 1);
    expect(await runStub(runId).taskLive(task)).toBe(true);
    await advance(runId, 1);
    expect(await jobNamed(runId, "a")).toMatchObject({
      conclusion: "cancelled",
      logComplete: false,
    });
    expect(
      await runStub(runId).completeTask(task, { result: "success", logComplete: true }),
    ).toEqual({
      ok: false,
      code: "task_finished",
    });
  });
});

describe("deadlines", () => {
  it("times a job out: cancel requested at its timeout, timed_out after the grace", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a", ["timeout-minutes: 5"])));
    const task = await assignNamed(runId, "a");
    await advance(runId, 5 * MIN);
    expect(await runStub(runId).updateTask(task)).toEqual({ ok: true, cancel: true });
    await advance(runId, 2 * MIN);
    expect((await jobNamed(runId, "a")).conclusion).toBe("timed_out");
    expect(await runStub(runId).get()).toMatchObject({ conclusion: "failure" });
  });

  it("cancels a job no runner took in 24 hours", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    await advance(runId, 24 * 60 * MIN);
    expect((await jobNamed(runId, "a")).conclusion).toBe("cancelled");
  });

  it("fails a job whose runner stopped reporting for 10 minutes", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    const task = await assignNamed(runId, "a");
    await advance(runId, 9 * MIN);
    await runStub(runId).updateTask(task);
    await advance(runId, 9 * MIN);
    expect((await jobNamed(runId, "a")).status).toBe("in_progress");
    await advance(runId, MIN);
    expect(await jobNamed(runId, "a")).toMatchObject({ conclusion: "failure", logComplete: false });
  });
});

describe("re-runs", () => {
  it("starts a new attempt whose checks supersede; the old attempt's late result is refused twice", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    expect(await runStub(runId).rerun(f.owner.principalId)).toEqual({
      ok: false,
      code: "run_not_completed",
    });
    const old = await finish(runId, "a", "failure");
    await advance(runId, 2_000);
    const other = await repoWithCommit();
    expect(await runStub(runId).rerun(other.owner.principalId)).toEqual({ ok: true, attempt: 2 });
    await drain(runId);
    expect(await runStub(runId).get()).toMatchObject({
      attempt: 2,
      actor: f.owner.principalId,
      triggeringActor: other.owner.principalId,
    });
    expect(
      await runStub(runId).completeTask(old, { result: "success", logComplete: true }),
    ).toEqual({
      ok: false,
      code: "task_finished",
    });
    await advance(runId, 2_000);
    const late = await env.REPO.getByName(f.repo.id).recordCheckUpdates([
      { sha: f.sha, name: "a", attempt: 1, status: "completed", conclusion: "success" },
    ]);
    expect(late).toEqual(["stale_attempt"]);
    const assigned = (await runStub(runId).assign(
      (
        await jobNamed(runId, "a")
      ).jobId,
      "again",
    )) as AssignAnswer;
    expect(assigned).toMatchObject({ ok: true, actorId: f.owner.principalId, attempt: 2 });
  });
});

describe("erasure", () => {
  it("leaves a tombstone: reads see nothing, a later create is refused, a repeat succeeds", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, chain);
    await runStub(runId).erase();
    await runStub(runId).erase();
    expect(await runStub(runId).get()).toBeUndefined();
    expect(await runStub(runId).create(specFor(f, chain, { runId }))).toEqual({
      ok: false,
      code: "run_erased",
    });
    expect(await inRun(runId, (r) => r.jobs.nextAt())).toBeNull();
  });

  it("refuses create on an erased object that never held a run", async () => {
    const f = await repoWithCommit();
    const spec = specFor(f, chain);
    await runStub(spec.runId).erase();
    expect(await runStub(spec.runId).create(spec)).toEqual({ ok: false, code: "run_erased" });
  });
});
