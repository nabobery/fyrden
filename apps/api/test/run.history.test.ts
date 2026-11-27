// A run's state as its repository records it: reported by the run with its
// checks, in the order the run's own state gives (a late, repeated or lost
// report never moves it back), repaired by the weekly check, and never
// brought back once the run is forgotten.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type StartRunAnswer, startRun } from "../src/ci/runs.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { RunDO } from "../src/do/RunDO.js";
import { RUN_JOB } from "../src/do/run/engine.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  assignNamed,
  at,
  drain,
  expr,
  type Fixture,
  finish,
  inRun,
  job,
  now,
  ownerOf,
  repoWithCommit,
  runStub,
  specFor,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";

const SOURCE = workflow(job("build"));
const WEEK = 7 * 24 * 60 * 60_000;
const repoOf = (f: Fixture) => env.REPO.getByName(f.repo.id);

const recorded = (f: Fixture, runId: string) => inRepo(repoOf(f), (r: RepoDO) => r.runs.get(runId));

const listed = async (f: Fixture, runId: string) => {
  const row = await recorded(f, runId);
  return row && { attempt: row.attempt, phase: row.phase, conclusion: row.conclusion };
};

const writesIn = async (f: Fixture, work: () => Promise<unknown>) => {
  const repo = repoOf(f);
  await inRepo(repo, (r: RepoDO) => {
    const { sql } = r.git.context.storage;
    const exec = sql.exec.bind(sql);
    const counted = { rows: 0 };
    (r as unknown as { counted: typeof counted }).counted = counted;
    sql.exec = ((query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...(bindings as []));
      if (/\bci_runs\b/.test(query)) {
        const rows = cursor.toArray();
        counted.rows += cursor.rowsWritten;
        return { toArray: () => rows, rowsWritten: cursor.rowsWritten, one: () => rows[0] };
      }
      return cursor;
    }) as typeof sql.exec;
  });
  await work();
  return inRepo(repo, (r: RepoDO) => (r as unknown as { counted: { rows: number } }).counted.rows);
};

/** Starts a run with no job run yet: created, its first report still to send. */
async function created(f: Fixture, source = SOURCE, extra: Parameters<typeof specFor>[2] = {}) {
  const spec = specFor(f, source, extra);
  await at(spec.runId, T0);
  const answer: StartRunAnswer = await startRun(env, spec, { owner: await ownerOf(f.repo.id) });
  expect(answer.ok).toBe(true);
  await at(spec.runId, T0);
  return spec.runId;
}

const setHooks = (runId: string, hooks: RunDO["hooks"]) =>
  inRun(runId, (r) => {
    r.hooks = hooks;
  });

describe("a run's report", () => {
  it("is recorded with its facts once its first checks go out, and not before", async () => {
    const f = await repoWithCommit();
    const runId = await created(
      f,
      ["name: CI", `run-name: Deploy ${expr("github.actor")}`, "on: push", "jobs:", job("a")].join(
        "\n",
      ),
      { github: { workflow: "CI", run_number: "4", actor: "ana", event: {} } },
    );
    expect(await recorded(f, runId)).toBeUndefined();
    await drain(runId);
    await advance(runId, 2_000);
    expect(await recorded(f, runId)).toEqual({
      runId,
      sha: f.sha,
      path: ".github/workflows/ci.yml",
      event: "push",
      actor: f.owner.principalId,
      triggeringActor: f.owner.principalId,
      headBranch: "main",
      attempt: 1,
      phase: "in_progress",
      conclusion: null,
      runNumber: 4,
      name: "CI",
      title: "Deploy ana",
      pullNumber: null,
      fork: false,
      createdAt: T0,
      updatedAt: T0,
      startedAt: T0,
      completedAt: null,
    });
  });

  it("follows the run to its end and through a re-run", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    await finish(runId, "build", "failure");
    await advance(runId, 2_000);
    expect(await listed(f, runId)).toEqual({
      attempt: 1,
      phase: "completed",
      conclusion: "failure",
    });
    const rerunner = "usr_rerunner";
    expect((await runStub(runId).rerun(rerunner)).ok).toBe(true);
    await drain(runId);
    await advance(runId, 2_000);
    expect(await recorded(f, runId)).toMatchObject({
      attempt: 2,
      phase: "in_progress",
      conclusion: null,
      actor: f.owner.principalId,
      triggeringActor: rerunner,
      completedAt: null,
    });
  });

  it("records a run waiting for its concurrency group, then cancelled before it ran", async () => {
    const f = await repoWithCommit();
    const source = `concurrency: deploy\n${SOURCE}`;
    const first = await started(f, source);
    await advance(first, 2_000);
    const second = await started(f, source);
    await advance(second, 2_000);
    expect((await listed(f, first))?.phase).toBe("in_progress");
    expect((await listed(f, second))?.phase).toBe("pending");
    expect((await runStub(second).cancel(f.owner.principalId, "graceful")).ok).toBe(true);
    await advance(second, 2_000);
    expect(await listed(f, second)).toEqual({
      attempt: 1,
      phase: "completed",
      conclusion: "cancelled",
    });
  });

  it("records a workflow that could not run", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, "name: ci\non: push\njobs: {}\n");
    await advance(runId, 2_000);
    expect(await recorded(f, runId)).toMatchObject({
      phase: "completed",
      conclusion: "failure",
      title: "ci",
    });
  });

  it("records a held run as waiting, and an approval of one queued for its group", async () => {
    const f = await repoWithCommit();
    const source = `concurrency: deploy\n${SOURCE}`;
    const holder = await started(f, source);
    const runId = await started(f, source, {
      event: "pull_request",
      ref: "refs/pull/1/head",
      trust: "untrusted",
      fork: true,
      approval: { workflowBlob: "b".repeat(40), action: "opened" },
      github: { head_ref: "topic", event: { pull_request: { number: 1, title: "Topic" } } },
    });
    await advance(runId, 2_000);
    expect(await recorded(f, runId)).toMatchObject({
      phase: "waiting",
      conclusion: null,
      headBranch: "topic",
      pullNumber: 1,
      title: "Topic",
      fork: true,
    });
    const binding = await inRun(
      runId,
      (r) =>
        r.engine.rows<{ binding: string }>("SELECT binding FROM run_approval")[0]?.binding ?? "",
    );
    // Its group's request is not answered yet, so the approval alone moves it.
    await setHooks(runId, {
      beforeRepoCall: (op) => {
        if (op === "acquireConcurrency") throw new Error("held");
      },
    });
    await advance(runId, 3_600_000);
    const approvedAt = now(runId);
    expect(await runStub(runId).approve(binding, f.owner.principalId)).toEqual({ ok: true });
    await advance(runId, 2_000);
    expect(await recorded(f, runId)).toMatchObject({ phase: "queued", updatedAt: approvedAt });
    await setHooks(runId, {});
    await advance(runId, 60_000);
    await advance(runId, 2_000);
    expect((await listed(f, runId))?.phase).toBe("pending");
    expect((await runStub(holder).cancel(f.owner.principalId, "force")).ok).toBe(true);
  });

  it("records a superseded approval's end", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, SOURCE, {
      event: "pull_request",
      ref: "refs/pull/1/head",
      trust: "untrusted",
      fork: true,
      approval: { workflowBlob: "b".repeat(40), action: "opened" },
    });
    await advance(runId, 2_000);
    expect((await listed(f, runId))?.phase).toBe("waiting");
    expect(await runStub(runId).supersede()).toEqual({ ok: true });
    await advance(runId, 2_000);
    expect(await listed(f, runId)).toEqual({
      attempt: 1,
      phase: "completed",
      conclusion: "cancelled",
    });
  });
});

describe("the order of reports", () => {
  it("keeps a completed run completed when an earlier report lands after it", async () => {
    const f = await repoWithCommit();
    const runId = await created(f);
    await drain(runId);
    const early = await inRun(runId, (r) => r.runReport());
    if (!early) throw new Error("no report");
    await advance(runId, 2_000);
    await finish(runId, "build");
    await advance(runId, 2_000);
    const before = await recorded(f, runId);
    expect(before?.phase).toBe("completed");
    expect(await writesIn(f, () => repoOf(f).reportRun(early))).toBe(0);
    expect(await recorded(f, runId)).toEqual(before);
  });

  it("writes nothing for a report repeated after an eviction", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    const calls: string[] = [];
    await inRun(runId, (r) => {
      // What an eviction loses: which report the repository last took.
      r.forgetReported();
      r.hooks = { beforeRepoCall: (op) => void calls.push(op) };
    });
    const rows = await writesIn(f, async () => {
      await inRun(runId, (r) => r.jobs.ensure("run_checks", RUN_JOB.checks));
      await drain(runId);
    });
    expect(calls).toContain("reportRun");
    expect(rows).toBe(0);
  });

  it("sends a state that moved during a report next", async () => {
    const f = await repoWithCommit();
    const runId = await created(f);
    await drain(runId);
    let cancelled = false;
    await setHooks(runId, {
      afterRepoCall: async (op) => {
        if (op !== "reportRun" || cancelled) return;
        cancelled = true;
        await runStub(runId).cancel(f.owner.principalId, "force");
      },
    });
    await advance(runId, 2_000);
    expect(cancelled).toBe(true);
    await advance(runId, 2_000);
    expect((await listed(f, runId))?.phase).toBe("completed");
  });

  it("sends a check changed during a report next", async () => {
    const f = await repoWithCommit();
    const runId = await created(f);
    await drain(runId);
    let assigned = false;
    await setHooks(runId, {
      afterRepoCall: async (op) => {
        if (op !== "reportRun" || assigned) return;
        assigned = true;
        await assignNamed(runId, "build");
      },
    });
    await advance(runId, 2_000);
    expect(assigned).toBe(true);
    await advance(runId, 2_000);
    const owed = await inRun(
      runId,
      (r) => r.engine.rows("SELECT 1 FROM run_checks WHERE sent_rev < rev").length,
    );
    expect(owed).toBe(0);
  });

  it("is sent again after a failure, the checks with it not", async () => {
    const f = await repoWithCommit();
    const runId = await created(f);
    await drain(runId);
    let failures = 2;
    const calls: string[] = [];
    await setHooks(runId, {
      beforeRepoCall: (op) => {
        calls.push(op);
        if (op === "reportRun" && failures-- > 0) throw new Error("repository away");
      },
    });
    await advance(runId, 2_000);
    expect(await recorded(f, runId)).toBeUndefined();
    await advance(runId, 60_000);
    await advance(runId, 60_000);
    expect((await listed(f, runId))?.phase).toBe("in_progress");
    expect(calls.filter((op) => op === "startCheckAttempts")).toHaveLength(1);
  });
});

describe("a run's row", () => {
  it("costs its repository one row a phase, and the indexes it is listed by once", async () => {
    const f = await repoWithCommit();
    const rows = await writesIn(f, async () => {
      const runId = await started(f, SOURCE);
      await advance(runId, 2_000);
      await finish(runId, "build");
      await advance(runId, 2_000);
    });
    // Registered: the row and its two index entries. First report: the row and its entry among
    // those not completed. Completed: the row (an index entry's removal is not counted).
    expect(rows).toBe(6);
  });

  it("is written again by the weekly check, for a row from before it was reported", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    await finish(runId, "build");
    await advance(runId, 2_000);
    const before = await recorded(f, runId);
    // As a version that reported nothing left it.
    await inRepo(repoOf(f), (r: RepoDO) => {
      const { sql } = r.git.context.storage;
      sql.exec("DELETE FROM ci_runs WHERE run_id = ?", runId);
      sql.exec(
        "INSERT INTO ci_runs (run_id, sha, workflow_path, created_at) VALUES (?, ?, ?, 1)",
        runId,
        f.sha,
        ".github/workflows/ci.yml",
      );
    });
    expect(await recorded(f, runId)).toBeUndefined();
    await advance(runId, WEEK);
    expect(await recorded(f, runId)).toEqual(before);
  });

  it("is written again by the weekly check, for a run a restore dropped, with its own time", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    const before = await recorded(f, runId);
    await inRepo(repoOf(f), (r: RepoDO) => {
      r.git.context.storage.sql.exec("DELETE FROM ci_runs WHERE run_id = ?", runId);
    });
    await finish(runId, "build");
    await advance(runId, 2_000);
    expect(await recorded(f, runId)).toBeUndefined();
    await advance(runId, WEEK);
    expect(await recorded(f, runId)).toMatchObject({
      phase: "completed",
      createdAt: before?.createdAt,
    });
  });

  it("stays gone when a report lands after the run was forgotten", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    const late = await inRun(runId, (r) => r.runReport());
    if (!late) throw new Error("no report");
    expect(await repoOf(f).forgetRun({ runId })).toEqual({ ok: true });
    expect(await repoOf(f).reportRun(late)).toEqual({ ok: true, recorded: false, epoch: 1 });
    expect(
      await inRepo(
        repoOf(f),
        (r: RepoDO) =>
          r.git.context.storage.sql.exec("SELECT 1 FROM ci_runs WHERE run_id = ?", runId).toArray()
            .length,
      ),
    ).toBe(0);
  });

  it("refuses a report that is not one", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, SOURCE);
    const report = await inRun(runId, (r) => r.runReport());
    if (!report) throw new Error("no report");
    for (const bad of [
      { ...report, runId: "x" },
      { ...report, phase: "done" as never },
      { ...report, attempt: 0 },
      { ...report, phase: "completed" as const, conclusion: null },
      { ...report, conclusion: "success" as const },
    ])
      await expect(inRepo(repoOf(f), (r: RepoDO) => r.reportRun(bad))).rejects.toThrow(
        "invalid run report",
      );
  });

  it("erases the run when its repository is gone", async () => {
    const f = await repoWithCommit();
    const runId = await created(f);
    await drain(runId);
    await inRun(runId, (r) => {
      r.jobs.ensure("run_checks", RUN_JOB.checks);
    });
    await setHooks(runId, {
      beforeRepoCall: (op) => {
        if (op === "reportRun" || op === "registerRun" || op === "startCheckAttempts")
          throw new Error("repo_not_found");
      },
    });
    await advance(runId, 2_000);
    expect(await runStub(runId).get()).toBeUndefined();
    expect(now(runId)).toBeGreaterThan(T0);
  });
});
