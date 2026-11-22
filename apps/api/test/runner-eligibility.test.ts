// Which jobs a runner may be given, decided by the server alone: never a
// public repository's job, never a fork job (a pull request whose head is
// in another repository, whatever the trust), whatever labels the runner
// declares and whether or not the run was approved. A run reserves (and so
// publishes) only jobs eligible when it reserves them; visibility is read
// again by the claim itself and by every re-offer, so a repository made public
// after its job was queued is covered; a re-offer refused for that reason
// leaves the job queued, and a lost answer whose task was already
// assigned is not delivered, so an ephemeral runner takes nothing else
// until that task ends at run state's heartbeat deadline.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import { approvalBinding } from "../src/ci/approval.js";
import type { RunSpec } from "../src/do/run/spec.js";
import { dispatchHooks } from "../src/runner/dispatch.js";
import { Result } from "../src/runner/proto/messages.js";
import { api, json } from "./helpers/api.js";
import { encodeFetchTaskRequest } from "./helpers/runner-proto.js";
import {
  fetchTask,
  jobTokensOf,
  orgRepo,
  pendingOf,
  type RegisteredRunner,
  registerRunner,
  runnerCall,
  tasksOfRun,
  tasksVersionOf,
  updateTask,
} from "./helpers/runners.js";
import {
  advance,
  drain,
  type Fixture,
  inRun,
  job,
  jobsOf,
  runStub,
  specFor,
  started,
  workflow,
} from "./helpers/runs.js";

const MIN = 60_000;
const one = workflow(job("a"));
const pullWorkflow = (event: string) =>
  `name: ci\non: ${event}\njobs:\n${job("a", ["permissions: write-all"])}`;

type OrgFixture = Fixture & { org: { id: string; login: string } };

afterEach(() => {
  delete dispatchHooks.afterClaim;
});

const setVisibility = (f: OrgFixture, visibility: "public" | "internal" | "private") =>
  env.DIRECTORY.prepare("UPDATE repos SET visibility = ? WHERE id = ?")
    .bind(visibility, f.repo.id)
    .run();

/** Another repository of the fixture's organization, with one commit on main. */
async function siblingRepo(f: OrgFixture): Promise<OrgFixture> {
  const repo = await json<{ id: string; name: string }>(
    api("POST", `/orgs/${f.org.login}/repos`, f.owner.token, { name: uniqueId("r") }),
  );
  expect(repo.status).toBe(201);
  const path = `/repos/${f.org.login}/${repo.body.name}`;
  const commit = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, f.owner.token, {
      branch: "main",
      message: "one",
      changes: [{ path: "a.txt", content: "one\n" }],
    }),
  );
  expect(commit.status).toBe(201);
  return { ...f, repo: repo.body, path, sha: commit.body.commit.sha };
}

/** The account's tasks version made non-zero: a run's job published, then cancelled and withdrawn. */
async function primed(f: OrgFixture): Promise<number> {
  const runId = await started(f, one);
  await runStub(runId).cancel(f.owner.principalId, "graceful");
  await drain(runId);
  expect(await pendingOf(runId)).toEqual([]);
  return tasksVersionOf(f.org.id);
}

/** A fork pull request run of `event`, waiting for its approval. */
function forkSpec(f: OrgFixture, event: "pull_request" | "pull_request_target"): RunSpec {
  return specFor(f, pullWorkflow(event), {
    event,
    ref: event === "pull_request" ? "refs/pull/1/head" : "refs/heads/main",
    github: { event_name: event, workflow: "ci" },
    trust: event === "pull_request" ? "untrusted" : "trusted",
    fork: true,
    approval: { workflowBlob: "b".repeat(40), action: "opened" },
  });
}

/** Runners of the organization with every label a workflow might ask for, one of them ephemeral. */
async function everyRunner(f: OrgFixture): Promise<RegisteredRunner[]> {
  return [
    await registerRunner(f.org.login, f.owner),
    await registerRunner(f.org.login, f.owner, {
      labels: ["ubuntu-latest", "self-hosted", "fork", "untrusted", "public"],
    }),
    await registerRunner(f.org.login, f.owner, { ephemeral: true }),
  ];
}

/**
 * Each runner polls with dispatch on, under Free's poll meter, and is given
 * nothing. The account's tasks version must be past 0 (`primed`), so a poll at
 * 0 searches for a job and answers with that version: it reached dispatch.
 */
async function noRunnerGetsIt(f: OrgFixture, runners: readonly RegisteredRunner[], runId: string) {
  const version = await tasksVersionOf(f.org.id);
  expect(version).toBeGreaterThan(0);
  for (const runner of runners) {
    expect(await fetchTask(runner, 0)).toEqual({ tasksVersion: version });
    const metered = await env.DIRECTORY.prepare("SELECT poll_used FROM ci_runners WHERE id = ?")
      .bind(runner.id)
      .first<number>("poll_used");
    expect(metered).toBeGreaterThan(0);
  }
  expect(await tasksOfRun(runId)).toEqual([]);
}

describe("job eligibility", () => {
  it("a private repository's same-repository job is assigned, its rows naming the repository", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    expect(await pendingOf(runId)).toMatchObject([{ repo_id: f.repo.id, fork: 0 }]);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    expect(task).toBeDefined();
    expect(await tasksOfRun(runId)).toMatchObject([
      { id: task?.id, task: 1, repo_id: f.repo.id, fork: 0 },
    ]);
  });

  it("an internal repository's job is assigned", async () => {
    const f = await orgRepo();
    await setVisibility(f, "internal");
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(runner, 0)).task).toBeDefined();
    expect(await tasksOfRun(runId)).toHaveLength(1);
  });

  it("a public repository's job is never assigned, whatever the runner's labels", async () => {
    const f = await orgRepo();
    await primed(f);
    await setVisibility(f, "public");
    const runId = await started(f, one);
    // Never reserved, so never published.
    expect(await pendingOf(runId)).toEqual([]);
    await noRunnerGetsIt(f, await everyRunner(f), runId);
    // Still queued, for run state's queue deadline to end.
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["queued"]);
  });

  it("a repository made public after its job was queued is not assigned; made private again, it is", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    await setVisibility(f, "public");
    const version = await tasksVersionOf(f.org.id);
    expect(await fetchTask(runner, 0)).toEqual({ tasksVersion: version });
    expect(await tasksOfRun(runId)).toEqual([]);
    expect(await pendingOf(runId)).toMatchObject([{ claimed_by: null }]);
    await setVisibility(f, "private");
    expect((await fetchTask(runner, 0)).task).toBeDefined();
  });

  it("a repository being deleted has its jobs assigned to no runner", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleting' WHERE id = ?")
      .bind(f.repo.id)
      .run();
    const runner = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(runId)).toEqual([]);
  });

  for (const event of ["pull_request", "pull_request_target"] as const)
    it(`a fork ${event} run is assigned to no runner, before or after its approval`, async () => {
      const f = await orgRepo();
      await primed(f);
      const runners = await everyRunner(f);
      const spec = forkSpec(f, event);
      const runId = await started(f, spec.workflow.source, spec);
      expect(await pendingOf(runId)).toEqual([]);
      await noRunnerGetsIt(f, runners, runId);

      const binding = await approvalBinding(spec);
      expect(await runStub(runId).approve(binding as string, f.owner.principalId)).toEqual({
        ok: true,
      });
      await drain(runId);
      // Approved, it is still a fork job: never reserved, never published.
      expect(await pendingOf(runId)).toEqual([]);
      await noRunnerGetsIt(f, runners, runId);
      expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["queued"]);
    });

  it("a fork run that needs no approval is assigned to no runner", async () => {
    const f = await orgRepo();
    await primed(f);
    const runners = await everyRunner(f);
    const { approval: _, ...spec } = forkSpec(f, "pull_request");
    const runId = await started(f, spec.workflow.source, spec);
    expect(await pendingOf(runId)).toEqual([]);
    await noRunnerGetsIt(f, runners, runId);
  });

  it("retires a real queued job whose directory row has pre-0053 defaults", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = await started(f, one);
    await env.DIRECTORY.prepare(
      "UPDATE ci_pending_jobs SET repo_id = '', fork = 1 WHERE run_id = ?",
    )
      .bind(runId)
      .run();
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    await advance(runId, 24 * 60 * MIN + 1);
    expect((await jobsOf(runId)).map((j) => [j.status, j.conclusion])).toEqual([
      ["completed", "cancelled"],
    ]);
    expect(await pendingOf(runId)).toEqual([]);
    expect(await tasksOfRun(runId)).toEqual([]);
  });

  it("lets a delivered legacy task finish but denies dependent jobs and reruns with unknown origin", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = await started(f, workflow([job("a"), job("b", ["needs: a"])].join("\n")));
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    await updateTask(runner, task.id);
    await inRun(runId, (r) => r.engine.exec("UPDATE runs SET trust = 'untrusted', fork = 1"));
    await env.DIRECTORY.prepare("UPDATE ci_tasks SET repo_id = '', fork = 1 WHERE id = ?")
      .bind(task.id)
      .run();
    await updateTask(runner, task.id);
    await updateTask(runner, task.id, Result.SUCCESS);
    await drain(runId);
    expect((await jobsOf(runId)).map((j) => [j.status, j.conclusion])).toEqual([
      ["completed", "success"],
      ["queued", null],
    ]);
    expect((await tasksOfRun(runId))[0]?.ended_at).not.toBeNull();
    expect((await jobTokensOf(task.id))[0]?.revoked_at).not.toBeNull();
    const pending = await env.DIRECTORY.prepare(
      "SELECT repo_id, fork FROM ci_pending_jobs WHERE run_id = ?",
    )
      .bind(runId)
      .all();
    // The run's origin is unknown (a fork, closed): its next job is never reserved or published.
    expect(pending.results).toEqual([]);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    await advance(runId, 24 * 60 * MIN + 1);
    expect((await jobsOf(runId)).map((j) => j.conclusion)).toEqual(["success", "cancelled"]);
    expect(await pendingOf(runId)).toEqual([]);
    expect(await runStub(runId).rerun(f.owner.principalId)).toMatchObject({ ok: true, attempt: 2 });
    await drain(runId);
    expect(await inRun(runId, (r) => r.engine.rows("SELECT trust, fork FROM runs"))).toEqual([
      { trust: "untrusted", fork: 1 },
    ]);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
  });

  it("rows written before the eligibility columns existed are never offered", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = `run-${uniqueId("old")}`;
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `INSERT INTO ci_pending_jobs (account_id, run_id, job_id, attempt, labels, queued_at)
         VALUES (?, ?, 1, 1, '["ubuntu-latest"]', ?)`,
      ).bind(f.org.id, runId, Date.now()),
      env.DIRECTORY.prepare(
        `INSERT INTO ci_dispatch (account_id, tasks_version) VALUES (?, 1)
         ON CONFLICT (account_id) DO UPDATE SET tasks_version = tasks_version + 1`,
      ).bind(f.org.id),
    ]);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(runId)).toEqual([]);

    // An unassigned offer of that time, repeated by its runner: superseded, not offered.
    const version = await tasksVersionOf(f.org.id);
    const offer = await env.DIRECTORY.prepare(
      `INSERT INTO ci_tasks (run_id, job_id, runner_id, offered_version, created_at)
       VALUES (?, 2, ?, ?, ?) RETURNING id`,
    )
      .bind(runId, runner.id, version, Date.now())
      .first<{ id: number }>();
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    const [row] = await tasksOfRun(runId);
    expect(row).toMatchObject({ id: offer?.id, task: null });
    expect(row?.superseded_at).not.toBeNull();
  });
});

describe("a re-offer of a job no longer eligible", () => {
  it("never assigned: the offer is superseded and the job stays queued", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const runId = await started(f, one);
    // The claim's Worker dies before the assignment: an offer at `version`, never assigned.
    dispatchHooks.afterClaim = () => {
      throw new Error("the Worker died");
    };
    const crashed = await runnerCall(
      "FetchTask",
      encodeFetchTaskRequest({ tasksVersion: version }),
      { credentials: runner },
    );
    expect(crashed.status).toBe(500);
    delete dispatchHooks.afterClaim;
    const [offer] = await tasksOfRun(runId);
    expect(offer).toMatchObject({ runner_id: runner.id, task: null, superseded_at: null });

    await setVisibility(f, "public");
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    const [after] = await tasksOfRun(runId);
    expect(after).toMatchObject({ id: offer?.id, task: null });
    expect(after?.superseded_at).not.toBeNull();
    expect(await jobTokensOf(offer?.id ?? 0)).toEqual([]);
    // The job is still queued, its row published, and no runner takes it.
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["queued"]);
    expect(await pendingOf(runId)).toHaveLength(1);
    const other = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(other, 0)).task).toBeUndefined();
    expect(await tasksOfRun(runId)).toHaveLength(1);
  });

  it("already assigned (a lost answer): not delivered, and the ephemeral runner takes nothing else until the task ends at the heartbeat deadline", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const version = await primed(f);
    const runId = await started(f, one);
    const lost = (await fetchTask(runner, version)).task;
    if (!lost) throw new Error("no task");

    await setVisibility(f, "public");
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    const [offer] = await tasksOfRun(runId);
    // Still a live offer: assigned, not superseded.
    expect(offer).toMatchObject({ id: lost.id, task: 1, superseded_at: null, ended_at: null });
    expect(await jobTokensOf(lost.id)).toHaveLength(1);

    // A private repository's job is waiting: the ephemeral runner gets no other job.
    const sibling = await siblingRepo(f);
    const waiting = await started(sibling, one);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    expect(await tasksOfRun(waiting)).toEqual([]);

    // Nobody runs the task: run state's heartbeat deadline fails it, and its end revokes the
    // token, ends the offer and spends the ephemeral credential.
    await advance(runId, 10 * MIN + 1);
    expect((await jobsOf(runId)).map((j) => [j.status, j.conclusion])).toEqual([
      ["completed", "failure"],
    ]);
    const run = await inRun(runId, (r) => r.engine.run());
    expect(run?.task_end_acked).toBe(run?.task_end_seq);
    expect((await tasksOfRun(runId))[0]?.ended_at).not.toBeNull();
    expect((await jobTokensOf(lost.id))[0]?.revoked_at).not.toBeNull();
    const spent = await env.DIRECTORY.prepare("SELECT expires_at FROM ci_runners WHERE id = ?")
      .bind(runner.id)
      .first<{ expires_at: number | null }>();
    expect(spent?.expires_at).not.toBeNull();
    // The waiting job was eligible all along: another runner takes it.
    const other = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(other, 0)).task).toBeDefined();
    expect(await tasksOfRun(waiting)).toHaveLength(1);
  });
});
