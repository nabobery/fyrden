// Handing queued jobs to runners: each run publishes its queued jobs to the
// account's dispatch index in D1, FetchTask claims one with a lease and has
// the run assign it, a lost answer is offered again only to the runner that
// lost it, reports are fenced by the run, an ephemeral runner gets one task,
// and the job token a task carries reads its one repository over git only
// while its task is live.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRun } from "../src/ci/runs.js";
import type { AssignAnswer, RunDO } from "../src/do/RunDO.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
import { dispatchHooks } from "../src/runner/dispatch.js";
import { Result, type Task } from "../src/runner/proto/messages.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user } from "./helpers/api.js";
import { countingD1 } from "./helpers/d1.js";
import { fetchBody } from "./helpers/fetch-repo.js";
import { basic, ORIGIN } from "./helpers/git-http.js";
import {
  decodeUpdateLogResponse,
  encodeDeclareRequest,
  encodeFetchTaskRequest,
  encodeUpdateLogRequest,
} from "./helpers/runner-proto.js";
import {
  call,
  connectError,
  fetchTask,
  gate,
  jobTokenOf,
  jobTokensOf,
  newOrg,
  ON,
  orgRepo,
  pendingOf,
  ROOMY_FLEET,
  registerRunner,
  runnerCall,
  taskRow,
  tasksOfRun,
  tasksVersionOf,
  updateTask,
  updateTaskRaw,
} from "./helpers/runners.js";
import {
  advance,
  assignNamed,
  at,
  drain,
  type Fixture,
  inRun,
  job,
  jobNamed,
  now,
  runStub,
  specFor,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";

const MIN = 60_000;
const one = workflow(job("a"));
const two = workflow([job("a"), job("b")].join("\n"));

afterEach(() => {
  delete dispatchHooks.afterClaim;
  delete dispatchHooks.beforeClaim;
});

/** Transfers the fixture's repository to organization `to`. */
async function transfer(f: Fixture & { org: { login: string } }, to: string) {
  const moved = await json<{ state: string }>(
    api("POST", `/repos/${f.org.login}/${f.repo.name}/transfer`, f.owner.token, { new_owner: to }),
  );
  expect(moved).toMatchObject({ status: 200, body: { state: "transferred" } });
}

/** A git protocol v2 fetch of the fixture's commit with `token`, as git sends it. */
function uploadPack(f: Fixture & { org: { login: string } }, token: string) {
  return exports.default.fetch(`${ORIGIN}/${f.org.login}/${f.repo.name}.git/git-upload-pack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-git-upload-pack-request",
      "Git-Protocol": "version=2",
      Authorization: basic(token),
    },
    body: fetchBody([`want ${f.sha}`, "done"]),
  });
}

const text = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());

/** The account's tasks version made non-zero: a run's job published, then cancelled and withdrawn. */
async function primed(f: Fixture & { org: { id: string } }): Promise<number> {
  const runId = await started(f, one);
  await runStub(runId).cancel(f.owner.principalId, "graceful");
  await drain(runId);
  expect(await pendingOf(runId)).toEqual([]);
  const version = await tasksVersionOf(f.org.id);
  expect(version).toBeGreaterThan(0);
  return version;
}

/** `env.RUN`, counting the run objects asked for. */
function countingRuns(count: { stubs: number }): DurableObjectNamespace<RunDO> {
  return new Proxy(env.RUN, {
    get(target, prop) {
      if (prop === "getByName")
        return (name: string) => {
          count.stubs++;
          return target.getByName(name);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Runs one step of the run's scheduling in a transaction, as its advance slice would. */
async function step(runId: string) {
  await runInDurableObject(runStub(runId), (run: RunDO, state) => {
    for (let i = 0; i < 10 && state.storage.transactionSync(() => run.engine.step()).more; i++);
  });
}

describe("the dispatch index", () => {
  it("publishes a run's queued job for its account, versioned", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const rows = await pendingOf(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: f.org.id,
      job_id: (await jobNamed(runId, "a")).jobId,
      attempt: 1,
      labels: '["ubuntu-latest"]',
      claimed_by: null,
    });
    expect(await tasksVersionOf(f.org.id)).toBe(1);
    const run = await inRun(runId, (r) => r.engine.run());
    expect(run?.queue_synced_rev).toBe(run?.queue_rev);
  });

  it("a change to the queue while the sync waits on D1 is published by a further pass", async () => {
    const f = await orgRepo();
    const runId = await started(f, workflow([job("a"), job("b", ["needs: a"])].join("\n")));
    const held = gate();
    await inRun(runId, (r) => {
      r.hooks = { beforeDispatchCommit: () => held.hold() };
    });
    const task = await assignNamed(runId, "a");
    const draining = drain(runId);
    await held.started;
    // While the slice's D1 batch is held: a ends and b is queued.
    expect(
      (await runStub(runId).completeTask(task, { result: "success", logComplete: true })).ok,
    ).toBe(true);
    await step(runId);
    expect((await jobNamed(runId, "b")).status).toBe("queued");
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    held.release();
    await draining;
    const rows = await pendingOf(runId);
    expect(rows.map((r) => r.job_id)).toEqual([(await jobNamed(runId, "b")).jobId]);
    const run = await inRun(runId, (r) => r.engine.run());
    expect(run?.queue_synced_rev).toBe(run?.queue_rev);
  });

  it("a reset after the D1 commit: the job assigned before the retry has its row deleted by it", async () => {
    const f = await orgRepo();
    const spec = specFor(f, one);
    await at(spec.runId, T0);
    let resets = 1;
    await inRun(spec.runId, (r) => {
      r.hooks = {
        afterDispatchCommit: () => {
          if (resets-- > 0) throw new Error("reset after the commit");
        },
      };
    });
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    // Published, but the slice never recorded it.
    expect(await pendingOf(spec.runId)).toHaveLength(1);
    await assignNamed(spec.runId, "a");
    await advance(spec.runId, 10 * MIN);
    expect(await pendingOf(spec.runId)).toEqual([]);
    const run = await inRun(spec.runId, (r) => r.engine.run());
    expect(run?.queue_synced_rev).toBe(run?.queue_rev);
  });

  it("a duplicate pass keeps one row and the version", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const version = await tasksVersionOf(f.org.id);
    await inRun(runId, (r) => {
      r.engine.exec("UPDATE runs SET queue_synced_rev = 0 WHERE id = 1");
      r.jobs.ensure("ci_dispatch", "dispatch", { runAt: r.context.now() });
    });
    await drain(runId);
    expect(await pendingOf(runId)).toHaveLength(1);
    expect(await tasksVersionOf(f.org.id)).toBe(version);
  });

  it("an instance cancelled while pending has its row deleted by the sync", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    expect(await pendingOf(runId)).toHaveLength(1);
    await runStub(runId).cancel(f.owner.principalId, "graceful");
    await drain(runId);
    expect(await pendingOf(runId)).toEqual([]);
  });
});

describe("FetchTask", () => {
  it("hands out the run's task: assign's payload, the job token in both secrets, a wire id that routes back", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const answer = await fetchTask(runner, 0);
    // A task-bearing answer keeps the runner's own version.
    expect(answer.tasksVersion).toBe(0);
    const task = answer.task;
    if (!task) throw new Error("no task");
    const [row] = await tasksOfRun(runId);
    expect(row).toMatchObject({
      id: task.id,
      runner_id: runner.id,
      offered_version: 0,
      task: 1,
      confirmed_at: null,
    });
    const again = (await runStub(runId).assign(row?.job_id ?? 0, `t${task.id}`)) as AssignAnswer;
    if (!again.ok) throw new Error(again.code);
    expect(task.workflowPayload).toEqual(again.payload);
    expect(task.context).toMatchObject({ ref: "refs/heads/main", event_name: "push" });
    // Short-form `uses:` actions resolve against this, not against the forge.
    expect(task.context).toMatchObject({ gitea_default_actions_url: "https://github.com" });
    expect(task.vars.size).toBe(0);
    const token = jobTokenOf(task);
    const [minted] = await jobTokensOf(task.id);
    expect(minted).toMatchObject({
      principal_id: f.owner.principalId,
      type: "job",
      repo_ids: JSON.stringify([f.repo.id]),
      scopes: JSON.stringify(["contents:read", "metadata:read"]),
      revoked_at: null,
    });
    expect(token.length).toBeGreaterThan(0);
    const report = await updateTask(runner, task.id);
    expect(report.state).toMatchObject({ id: task.id, result: Result.UNSPECIFIED });
  });

  it("an idle poll at the account's version is one D1 read and no run object", async () => {
    const f = await orgRepo();
    await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner, { labels: ["windows"] });
    // Nothing it may take: the current version.
    const first = await fetchTask(runner, 0);
    expect(first).toEqual({ tasksVersion: await tasksVersionOf(f.org.id) });
    const count = { stubs: 0 };
    const queries = { queries: 0 };
    const idle = await fetchTask(runner, first.tasksVersion, {
      overrides: { ...ON, RUN: countingRuns(count), DIRECTORY: countingD1(env.DIRECTORY, queries) },
    });
    expect(idle).toEqual({ tasksVersion: first.tasksVersion });
    expect(count.stubs).toBe(0);
    expect(queries.queries).toBe(1);
  });

  it("a capacity-one runner echoing its old version finds the second job with no new publication", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const old = await primed(f);
    expect(await fetchTask(runner, 0)).toEqual({ tasksVersion: old });
    const runId = await started(f, two);
    const published = await tasksVersionOf(f.org.id);
    expect(published).toBeGreaterThan(old);
    const a = await fetchTask(runner, old);
    expect(a.task).toBeDefined();
    expect(a.tasksVersion).toBe(old);
    // It runs A (its first report confirms it), then polls with the version it holds.
    await updateTask(runner, a.task?.id ?? 0);
    const b = await fetchTask(runner, old);
    expect(b.task).toBeDefined();
    expect(b.task?.id).not.toBe(a.task?.id);
    await updateTask(runner, b.task?.id ?? 0);
    expect(new Set((await tasksOfRun(runId)).map((t) => t.job_id)).size).toBe(2);
    expect(await tasksVersionOf(f.org.id)).toBe(published);
    // Nothing left: the current version.
    expect(await fetchTask(runner, old)).toEqual({ tasksVersion: published });
  });

  it("a claim whose Worker dies before the assignment stays leased, then another runner takes it", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const first = await registerRunner(f.org.login, f.owner);
    const second = await registerRunner(f.org.login, f.owner);
    dispatchHooks.afterClaim = () => {
      throw new Error("the Worker died");
    };
    const crashed = await runnerCall("FetchTask", new Uint8Array(), { credentials: first });
    expect(crashed.status).toBe(500);
    delete dispatchHooks.afterClaim;
    const [leased] = await pendingOf(runId);
    expect(leased?.claimed_by).toBe(first.id);
    const version = await tasksVersionOf(f.org.id);
    // Leased: nothing for anyone.
    expect(await fetchTask(second, 0)).toEqual({ tasksVersion: version });
    vi.setSystemTime(Date.now() + 30_001);
    const taken = await fetchTask(second, version);
    expect(taken.task).toBeDefined();
    expect(taken.tasksVersion).toBe(version);
    expect(await tasksVersionOf(f.org.id)).toBe(version + 1);
    expect((await pendingOf(runId))[0]?.claimed_by).toBe(second.id);
    const rows = await tasksOfRun(runId);
    expect(rows.map((r) => [r.runner_id, r.task])).toEqual([
      [first.id, null],
      [second.id, 1],
    ]);
  });

  it("refuses a report on an offer whose assignment never reached the directory, which the lapsed claim's cleanup then supersedes", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const first = await registerRunner(f.org.login, f.owner);
    const second = await registerRunner(f.org.login, f.owner);
    // The run assigns and records the task, then the directory write fails.
    await inRun(runId, (r) => {
      r.hooks = {
        beforeTaskRecord: () => {
          throw new Error("the directory write failed");
        },
      };
    });
    expect(
      (await runnerCall("FetchTask", new Uint8Array(), { credentials: first })).status,
    ).not.toBe(200);
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    const [offer] = await tasksOfRun(runId);
    expect(offer).toMatchObject({ runner_id: first.id, task: null });
    // The runner guesses its own wire id and reports before the directory knows the task.
    const early = await updateTaskRaw(first, offer?.id ?? 0);
    expect(early.status).toBe(404);
    const confirmed = await env.DIRECTORY.prepare("SELECT confirmed_at FROM ci_tasks WHERE id = ?")
      .bind(offer?.id ?? 0)
      .first<{ confirmed_at: number | null }>();
    expect(confirmed?.confirmed_at).toBeNull();
    vi.setSystemTime(Date.now() + 30_001);
    await fetchTask(second, await tasksVersionOf(f.org.id));
    const after = await env.DIRECTORY.prepare("SELECT superseded_at FROM ci_tasks WHERE id = ?")
      .bind(offer?.id ?? 0)
      .first<{ superseded_at: number | null }>();
    expect(typeof after?.superseded_at).toBe("number");
  });

  it("two runners for one job: one task", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const first = await registerRunner(f.org.login, f.owner);
    const second = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(first, 0)).task).toBeDefined();
    expect((await fetchTask(second, 0)).task).toBeUndefined();
    expect(await tasksOfRun(runId)).toHaveLength(1);
  });

  it("two claims racing for one pending row: one task row, the losing batch inserts none", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runners = await Promise.all([
      registerRunner(f.org.login, f.owner),
      registerRunner(f.org.login, f.owner),
    ]);
    const answers = await Promise.all(runners.map((r) => fetchTask(r, 0)));
    expect(answers.filter((a) => a.task !== undefined)).toHaveLength(1);
    expect(await tasksOfRun(runId)).toHaveLength(1);
  });

  it("a runner whose labels do not cover the job's gets no task", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner, { labels: ["self-hosted"] });
    expect(await fetchTask(runner, 0)).toEqual({ tasksVersion: await tasksVersionOf(f.org.id) });
    expect(await tasksOfRun(runId)).toEqual([]);
    // Labels compare case-insensitively.
    const upper = await registerRunner(f.org.login, f.owner, { labels: ["UBUNTU-Latest"] });
    expect((await fetchTask(upper, 0)).task).toBeDefined();
  });

  it("a job cancelled before its assignment is refused, its task row superseded, and the next row taken", async () => {
    const f = await orgRepo();
    const cancelled = await started(f, one);
    const other = await started(f, one);
    // Cancelled, not yet withdrawn from the index.
    await runStub(cancelled).cancel(f.owner.principalId, "graceful");
    const runner = await registerRunner(f.org.login, f.owner);
    const answer = await fetchTask(runner, 0);
    expect(answer.task).toBeDefined();
    const [refused] = await tasksOfRun(cancelled);
    expect(refused).toMatchObject({ task: null, ended_at: null });
    expect(refused?.superseded_at).not.toBeNull();
    expect((await tasksOfRun(other))[0]?.id).toBe(answer.task?.id);
    // A report naming the superseded task is refused.
    await connectError(await updateTaskRaw(runner, refused?.id ?? 0), "failed_precondition", 400);
  });

  it("a job of an erased run: its row is deleted and the next poll finds nothing", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    await runStub(runId).erase(f.repo.id);
    const runner = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await pendingOf(runId)).toEqual([]);
    expect((await tasksOfRun(runId))[0]?.superseded_at).not.toBeNull();
  });

  it("the switch off: no task, and the runner's own version", async () => {
    const f = await orgRepo();
    await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    expect(await fetchTask(runner, 3, { overrides: ROOMY_FLEET })).toEqual({ tasksVersion: 3 });
  });
});

describe("a lost answer", () => {
  it("is offered again when the runner repeats the version it was offered with: same task, a new token, the old one refused", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const runId = await started(f, one);
    const first = await fetchTask(runner, version);
    const lost = first.task;
    if (!lost) throw new Error("no task");
    // The job's start window lapses: the replay is answered all the same.
    await at(runId, now(runId) + 31 * MIN);
    const again = await fetchTask(runner, version);
    expect(again.task?.id).toBe(lost.id);
    expect(again.tasksVersion).toBe(version);
    expect(again.task?.workflowPayload).toEqual(lost.workflowPayload);
    const rows = await tasksOfRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.task).toBe(1);
    const oldToken = jobTokenOf(lost);
    const newToken = jobTokenOf(again.task as typeof lost);
    expect(newToken).not.toBe(oldToken);
    const tokens = await jobTokensOf(lost.id);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.revoked_at).not.toBeNull();
    expect(tokens[1]?.revoked_at).toBeNull();
    expect((await uploadPack(f, oldToken)).status).toBe(401);
    expect((await uploadPack(f, newToken)).status).toBe(200);
  });

  it("is not offered again once the request's time is spent: no task, nothing touched", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const runId = await started(f, one);
    const lost = (await fetchTask(runner, version)).task;
    if (!lost) throw new Error("no task");
    // A budget of 1.5 s leaves nothing once the answer's margin is kept back.
    const spent = await fetchTask(runner, version, { headers: { "connect-timeout-ms": "1500" } });
    expect(spent).toEqual({ tasksVersion: version });
    const tokens = await jobTokensOf(lost.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revoked_at).toBeNull();
    expect((await tasksOfRun(runId)).map((t) => t.superseded_at ?? t.ended_at)).toEqual([null]);
    expect((await fetchTask(runner, version)).task?.id).toBe(lost.id);
  });

  it("capacity two: the next poll at version 0, while the first task's report is held, gets another job and leaves the first alone", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const runId = await started(f, two);
    const first = (await fetchTask(runner, version)).task;
    if (!first) throw new Error("no task");
    const held = gate();
    await inRun(runId, (r) => {
      r.hooks = { beforeReport: () => held.hold() };
    });
    const reporting = updateTaskRaw(runner, first.id);
    await held.started;
    const second = await fetchTask(runner, 0);
    expect(second.task).toBeDefined();
    expect(second.task?.id).not.toBe(first.id);
    const rows = await tasksOfRun(runId);
    expect(new Set(rows.map((r) => r.job_id)).size).toBe(2);
    // Nothing more, and the first task and its token as they were.
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await taskRow(first.id)).toMatchObject({ superseded_at: null, ended_at: null });
    const tokens = await jobTokensOf(first.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revoked_at).toBeNull();
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    held.release();
    expect((await reporting).status).toBe(200);
    expect((await taskRow(first.id))?.confirmed_at).not.toBeNull();
  });

  it("to a version-0 request is not offered again", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const first = (await fetchTask(runner, 0)).task;
    if (!first) throw new Error("no task");
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(runId)).toHaveLength(1);
    expect(await jobTokensOf(first.id)).toHaveLength(1);
  });

  it("is not offered again once the task is confirmed", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    await started(f, one);
    const first = (await fetchTask(runner, version)).task;
    if (!first) throw new Error("no task");
    await updateTask(runner, first.id);
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    const tokens = await jobTokensOf(first.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revoked_at).toBeNull();
  });

  it("keeps a fresh claim active when an overlapping poll assigns and confirms it first", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const runId = await started(f, one);
    const held = gate();
    dispatchHooks.afterClaim = () => held.hold();
    const claiming = fetchTask(runner, version);
    await held.started;
    delete dispatchHooks.afterClaim;
    let active: Task | undefined;
    try {
      active = (await fetchTask(runner, version)).task;
      if (!active) throw new Error("no task");
      await updateTask(runner, active.id);
      expect((await taskRow(active.id))?.confirmed_at).not.toBeNull();
    } finally {
      held.release();
    }
    const claimAnswer = await claiming;
    expect(claimAnswer.task).toBeUndefined();
    if (!active) throw new Error("no task");
    expect(await tasksOfRun(runId)).toHaveLength(1);
    expect(await taskRow(active.id)).toMatchObject({ superseded_at: null, ended_at: null });
    expect(claimAnswer.tasksVersion).toBe(version);
    expect((await uploadPack(f, jobTokenOf(active))).status).toBe(200);
    const logged = await runnerCall(
      "UpdateLog",
      encodeUpdateLogRequest({
        taskId: active.id,
        index: 0,
        rows: [{ content: "after the overlapping poll" }],
        noMore: true,
      }),
      { credentials: runner },
    );
    expect(logged.status).toBe(200);
    expect(decodeUpdateLogResponse(new Uint8Array(await logged.arrayBuffer())).ackIndex).toBe(1);
    const [chunk] = await inRun(runId, (r) =>
      r.engine.rows<{ r2_key: string }>("SELECT r2_key FROM ci_log_chunks"),
    );
    expect(chunk).toBeDefined();
    expect(await (await env.CI.get(chunk?.r2_key ?? ""))?.text()).toContain(
      "after the overlapping poll",
    );
    expect((await updateTaskRaw(runner, active.id, Result.SUCCESS)).status).toBe(200);
    expect(await jobNamed(runId, "a")).toMatchObject({
      status: "completed",
      conclusion: "success",
      logComplete: true,
    });
  });

  it.each(["beforeTaskRecord", "beforeTokenRotation"] as const)(
    "keeps the active token when confirmation interleaves at %s",
    async (hook) => {
      const f = await orgRepo();
      const runner = await registerRunner(f.org.login, f.owner);
      const version = await primed(f);
      const runId = await started(f, one);
      const first = (await fetchTask(runner, version)).task;
      if (!first) throw new Error("no task");
      const held = gate();
      await inRun(runId, (r) => {
        r.hooks = { [hook]: () => held.hold() };
      });
      const replaying = fetchTask(runner, version);
      await held.started;
      try {
        await updateTask(runner, first.id);
        expect((await taskRow(first.id))?.confirmed_at).not.toBeNull();
      } finally {
        held.release();
      }
      expect((await replaying).task).toBeUndefined();
      expect(await taskRow(first.id)).toMatchObject({ superseded_at: null, ended_at: null });
      const tokens = await jobTokensOf(first.id);
      expect(tokens[0]?.revoked_at).toBeNull();
      const audit = await env.DIRECTORY.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'token.revoke' AND target_id = ?",
      )
        .bind(tokens[0]?.id ?? "")
        .first<{ n: number }>();
      expect(audit?.n).toBe(0);
      expect((await uploadPack(f, jobTokenOf(first))).status).toBe(200);
      expect(tokens.slice(1).every((t) => t.revoked_at !== null)).toBe(true);
    },
  );

  it.each([false, true])(
    "skips an exhausted offer while its eighth answer is in flight (lapsed claim: %s)",
    async (lapsed) => {
      const f = await orgRepo();
      const runner = await registerRunner(f.org.login, f.owner);
      const version = await primed(f);
      const runId = await started(f, one);
      const first = (await fetchTask(runner, version)).task;
      if (!first) throw new Error("no task");
      // Past the job's start window, the replays are answered all the same.
      await at(runId, now(runId) + 31 * MIN);
      for (let i = 0; i < 6; i++)
        expect((await fetchTask(runner, version)).task?.id).toBe(first.id);
      const held = gate();
      await inRun(runId, (r) => {
        r.hooks = { beforeTaskAnswer: () => held.hold() };
      });
      const eighth = fetchTask(runner, version);
      let delivered: Task | undefined;
      try {
        await held.started;
        const otherRun = await started(f, one);
        if (lapsed)
          await env.DIRECTORY.prepare("UPDATE ci_pending_jobs SET claim_until = 0 WHERE run_id = ?")
            .bind(runId)
            .run();
        const other = (await fetchTask(runner, version)).task;
        expect(other).toBeDefined();
        expect(other?.id).not.toBe(first.id);
        expect((await taskRow(other?.id ?? 0))?.run_id).toBe(otherRun);
        expect(await taskRow(first.id)).toMatchObject({
          confirmed_at: null,
          ended_at: null,
          superseded_at: null,
        });
        const tokens = await jobTokensOf(first.id);
        expect(tokens).toHaveLength(8);
        expect(tokens.filter((token) => token.revoked_at === null)).toHaveLength(1);
      } finally {
        held.release();
        try {
          delivered = (await eighth).task;
        } finally {
          await inRun(runId, (r) => {
            r.hooks = {};
          });
        }
      }
      if (!delivered) throw new Error("the eighth answer was lost");
      expect(delivered.id).toBe(first.id);
      await updateTask(runner, delivered.id);
      expect((await uploadPack(f, jobTokenOf(delivered))).status).toBe(200);
      const logged = await runnerCall(
        "UpdateLog",
        encodeUpdateLogRequest({
          taskId: delivered.id,
          index: 0,
          rows: [{ content: "after the exhausted offer" }],
          noMore: true,
        }),
        { credentials: runner },
      );
      expect(logged.status).toBe(200);
      expect(decodeUpdateLogResponse(new Uint8Array(await logged.arrayBuffer())).ackIndex).toBe(1);
      expect(await jobTokensOf(first.id)).toHaveLength(8);
    },
  );

  it.each(["before commit", "after commit"] as const)(
    "retries a losing token's revocation that fails %s without duplicating its audit",
    async (failure) => {
      const f = await orgRepo();
      const runner = await registerRunner(f.org.login, f.owner);
      const version = await primed(f);
      const runId = await started(f, one);
      const first = (await fetchTask(runner, version)).task;
      if (!first) throw new Error("no task");
      const held = gate();
      await inRun(runId, (r) => {
        r.hooks = { beforeTokenRotation: () => held.hold() };
      });
      const replaying = runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: version }), {
        credentials: runner,
      }).then(async (response) => ({
        status: response.status,
        body: await response.json<{ code: string }>(),
      }));
      const prototype = Object.getPrototypeOf(env.DIRECTORY) as D1Database;
      const prepare = prototype.prepare;
      const batch = prototype.batch;
      const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
      const tracked = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
        const proxy = new Proxy(statement, {
          get(target, key) {
            if (key === "bind")
              return (...values: unknown[]) => tracked(target.bind(...values), sql);
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        sqlByStatement.set(proxy, sql);
        return proxy;
      };
      let attempts = 0;
      const prepareSpy = vi.spyOn(prototype, "prepare");
      const batchSpy = vi.spyOn(prototype, "batch");
      try {
        await held.started;
        await updateTask(runner, first.id);
        prepareSpy.mockImplementation(function (this: D1Database, sql: string) {
          return tracked(prepare.call(this, sql), sql);
        });
        batchSpy.mockImplementation(async function <T>(
          this: D1Database,
          statements: D1PreparedStatement[],
        ): Promise<D1Result<T>[]> {
          const own = statements.some((statement) => {
            const sql = sqlByStatement.get(statement) ?? "";
            return sql.includes("UPDATE tokens SET revoked_at") && !sql.includes("json_each");
          });
          if (own) attempts++;
          if (own && attempts === 1 && failure === "before commit")
            throw new Error("revocation write unavailable");
          const results = (await batch.call(this, statements)) as D1Result<T>[];
          if (own && attempts === 1 && failure === "after commit")
            throw new Error("revocation answer lost");
          return results;
        });
        held.release();
        expect(await replaying).toMatchObject({ status: 503, body: { code: "unavailable" } });
        expect(attempts).toBe(2);
        const tokens = await jobTokensOf(first.id);
        expect(tokens).toHaveLength(2);
        expect(tokens[0]?.revoked_at).toBeNull();
        expect(typeof tokens[1]?.revoked_at).toBe("number");
        const audit = await env.DIRECTORY.prepare(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'token.revoke' AND target_id = ?",
        )
          .bind(tokens[1]?.id ?? "")
          .first<{ n: number }>();
        expect(audit?.n).toBe(1);
        expect((await uploadPack(f, jobTokenOf(first))).status).toBe(200);
      } finally {
        held.release();
        await replaying.catch(() => undefined);
        prepareSpy.mockRestore();
        batchSpy.mockRestore();
        await inRun(runId, (r) => {
          r.hooks = {};
        });
      }
    },
  );

  it("after its task completed: the assignment answers task_finished, the row ends, and the poll searches as usual", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const runId = await started(f, one);
    const first = (await fetchTask(runner, version)).task;
    if (!first) throw new Error("no task");
    const ref = { jobId: (await jobNamed(runId, "a")).jobId, task: 1 };
    expect(
      (await runStub(runId).completeTask(ref, { result: "success", logComplete: false })).ok,
    ).toBe(true);
    const answer = await fetchTask(runner, version);
    expect(answer.task).toBeUndefined();
    expect(answer.tasksVersion).toBe(await tasksVersionOf(f.org.id));
    expect((await taskRow(first.id))?.ended_at).not.toBeNull();
  });
});

/** Marks the fixture's repository as being transferred: a transfer's first step, before its owner changes. */
async function transferStarts(f: Fixture & { org: { id: string } }) {
  await env.DIRECTORY.prepare(
    `INSERT INTO repo_transfers (repo_id, transfer_id, from_owner, from_name, to_owner, to_name,
       step, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'freeze', ?, ?)`,
  )
    .bind(
      f.repo.id,
      uniqueId("trf"),
      f.org.id,
      f.repo.name,
      f.org.id,
      f.repo.name,
      Date.now(),
      Date.now(),
    )
    .run();
}

/** An after-claim hook that holds the first claim only, then moves the clock past its deadline. */
function holdFirstClaim() {
  const held = gate();
  let first = true;
  dispatchHooks.afterClaim = async () => {
    if (!first) return;
    first = false;
    await held.hold();
    vi.setSystemTime(Date.now() + 10_000);
  };
  return held;
}

describe("a repository transfer", () => {
  it("fences the old account's runners off its jobs, which move to the new account", async () => {
    const f = await orgRepo();
    const to = await newOrg(f.owner);
    const runId = await started(f, one);
    const before = await registerRunner(f.org.login, f.owner);
    const after = await registerRunner(to.login, f.owner);
    await transfer(f, to.login);
    // The old account's runner claims the job it still sees, and the run refuses it.
    expect((await fetchTask(before, 0)).task).toBeUndefined();
    const [refused] = await tasksOfRun(runId);
    expect(refused).toMatchObject({ runner_id: before.id, task: null });
    expect(refused?.superseded_at).not.toBeNull();
    // The refusal set the index right: the row moved to the new account, unclaimed.
    await drain(runId);
    const [row] = await pendingOf(runId);
    expect(row).toMatchObject({ account_id: to.id, claimed_by: null, claim_until: null });
    expect(await tasksVersionOf(to.id)).toBeGreaterThan(0);
    const taken = await fetchTask(after, 0);
    expect(taken.task).toBeDefined();
    expect((await tasksOfRun(runId)).at(-1)).toMatchObject({ runner_id: after.id, task: 1 });
  });

  it("refuses a job while a transfer is under way, before assigning it", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    await transferStarts(f);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    const [refused] = await tasksOfRun(runId);
    expect(refused).toMatchObject({ task: null });
    expect(refused?.superseded_at).not.toBeNull();
    expect(await jobTokensOf(refused?.id ?? 0)).toEqual([]);
    expect((await jobNamed(runId, "a")).status).toBe("queued");
  });

  it("gives no task when a transfer starts between the assignment and the answer, and revokes its token", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    await inRun(runId, (r) => {
      r.hooks = { afterMint: () => transferStarts(f) };
    });
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    // Exactly one offer, which minted exactly one token: the refusal came
    // after the mint, not from an earlier check.
    const rows = await tasksOfRun(runId);
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]?.superseded_at).toBe("number");
    const tokens = await jobTokensOf(rows[0]?.id ?? 0);
    expect(tokens).toHaveLength(1);
    expect(typeof tokens[0]?.revoked_at).toBe("number");
  });

  it("is followed within 5 minutes while the run has jobs published, with no runner polling", async () => {
    const f = await orgRepo();
    const to = await newOrg(f.owner);
    const runId = await started(f, one);
    await transfer(f, to.login);
    await at(runId, now(runId) + 4 * MIN);
    await runDurableObjectAlarm(runStub(runId));
    expect((await pendingOf(runId))[0]?.account_id).toBe(f.org.id);
    await at(runId, now(runId) + MIN);
    expect(await runDurableObjectAlarm(runStub(runId))).toBe(true);
    expect((await pendingOf(runId))[0]?.account_id).toBe(to.id);
    // Once nothing is published, the run stops looking.
    await runStub(runId).cancel(f.owner.principalId, "graceful");
    await drain(runId);
    expect(await pendingOf(runId)).toEqual([]);
    expect(
      await inRun(
        runId,
        (r) =>
          r.engine.rows("SELECT 1 FROM jobs WHERE kind = 'ci_dispatch' AND state = 'queued'")
            .length,
      ),
    ).toBe(0);
  });
});

describe("an ephemeral runner's claims", () => {
  it("a claim whose Worker died does not keep it from its job once the lease lapses", async () => {
    const f = await orgRepo();
    await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    dispatchHooks.afterClaim = () => {
      throw new Error("the Worker died");
    };
    expect((await runnerCall("FetchTask", new Uint8Array(), { credentials: runner })).status).toBe(
      500,
    );
    delete dispatchHooks.afterClaim;
    vi.setSystemTime(Date.now() + 30_001);
    expect((await fetchTask(runner, 0)).task).toBeDefined();
  });

  it("a claim given up at the deadline before its assignment is released at once", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    dispatchHooks.afterClaim = () => {
      delete dispatchHooks.afterClaim;
      vi.setSystemTime(Date.now() + 10_000);
    };
    expect(await fetchTask(runner, 0)).toEqual({ tasksVersion: 0 });
    const [given] = await tasksOfRun(runId);
    expect(given?.superseded_at).not.toBeNull();
    expect((await pendingOf(runId))[0]).toMatchObject({ claimed_by: null, claim_until: null });
    expect((await fetchTask(runner, 0)).task).toBeDefined();
  });

  it("an expired unassigned offer is never offered again, even repeating its version", async () => {
    const f = await orgRepo();
    const version = await primed(f);
    const runId = await started(f, two);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const other = await registerRunner(f.org.login, f.owner);
    // The ephemeral runner claims a with the version it holds, and its Worker dies.
    dispatchHooks.afterClaim = () => {
      throw new Error("the Worker died");
    };
    const crashed = await runnerCall(
      "FetchTask",
      encodeFetchTaskRequest({ tasksVersion: version }),
      {
        credentials: runner,
      },
    );
    expect(crashed.status).toBe(500);
    // After the lease, another runner's claim of a dies too, so a stays queued and leased.
    vi.setSystemTime(Date.now() + 30_001);
    expect((await runnerCall("FetchTask", new Uint8Array(), { credentials: other })).status).toBe(
      500,
    );
    delete dispatchHooks.afterClaim;
    const [lapsed] = await tasksOfRun(runId);
    expect(lapsed?.superseded_at).not.toBeNull();
    // The ephemeral runner takes b and confirms it.
    const b = (await fetchTask(runner, 0)).task;
    if (!b) throw new Error("no task");
    await updateTask(runner, b.id);
    // Its first offer's version again: nothing.
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    expect((await tasksOfRun(runId)).filter((t) => t.task !== null)).toHaveLength(1);
  });

  it("a claim given up at the deadline releases nothing another poll of the runner assigned meanwhile", async () => {
    const f = await orgRepo();
    const version = await primed(f);
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const held = holdFirstClaim();
    const pausing = fetchTask(runner, version);
    await held.started;
    // The same runner asks again with the same version: its offer, re-offered and assigned.
    const [offer] = await tasksOfRun(runId);
    const again = await fetchTask(runner, version);
    expect(again.task?.id).toBe(offer?.id);
    held.release();
    expect((await pausing).task).toBeUndefined();
    expect((await taskRow(offer?.id ?? 0))?.superseded_at).toBeNull();
    expect((await pendingOf(runId))[0]?.claimed_by).toBe(runner.id);
    expect((await updateTask(runner, offer?.id ?? 0)).state?.result).toBe(Result.UNSPECIFIED);
  });

  it("a claim given up at the deadline makes runners that searched meanwhile search again", async () => {
    const f = await orgRepo();
    await started(f, one);
    const first = await registerRunner(f.org.login, f.owner);
    const second = await registerRunner(f.org.login, f.owner);
    const held = holdFirstClaim();
    const pausing = fetchTask(first, 0);
    await held.started;
    const searched = await fetchTask(second, 0);
    expect(searched.task).toBeUndefined();
    held.release();
    expect((await pausing).task).toBeUndefined();
    expect((await fetchTask(second, searched.tasksVersion)).task).toBeDefined();
  });

  it("two concurrent polls of one ephemeral credential get one task", async () => {
    const f = await orgRepo();
    const runId = await started(f, two);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const held = gate();
    let first = true;
    dispatchHooks.beforeClaim = async () => {
      if (!first) return;
      first = false;
      await held.hold();
    };
    // Both authenticated before either claims.
    const firstPoll = fetchTask(runner, 0);
    await held.started;
    const other = await fetchTask(runner, 0);
    held.release();
    const answers = [await firstPoll, other];
    expect(answers.filter((a) => a.task !== undefined)).toHaveLength(1);
    expect(await tasksOfRun(runId)).toHaveLength(1);
  });
});

describe("UpdateTask fencing", () => {
  it("answers CANCELLED once a cancel is requested", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    expect((await updateTask(runner, task.id)).state?.result).toBe(Result.UNSPECIFIED);
    await runStub(runId).cancel(f.owner.principalId, "graceful");
    expect((await updateTask(runner, task.id)).state?.result).toBe(Result.CANCELLED);
  });

  it("answers CANCELLED to the previous attempt's task after a re-run", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    await runStub(runId).cancel(f.owner.principalId, "force");
    await drain(runId);
    expect((await runStub(runId).rerun(f.owner.principalId)).ok).toBe(true);
    await drain(runId);
    expect((await updateTask(runner, task.id)).state).toMatchObject({
      id: task.id,
      result: Result.CANCELLED,
    });
  });

  it("answers CANCELLED for an erased run, whose job token then stops", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    await runStub(runId).erase(f.repo.id);
    expect((await updateTask(runner, task.id)).state?.result).toBe(Result.CANCELLED);
    expect((await uploadPack(f, jobTokenOf(task))).status).toBe(401);
  });
});

describe("an ephemeral runner", () => {
  it("gets one task: offered again if lost, none more while it runs, then spent until completion + 10 min", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const version = await primed(f);
    const runId = await started(f, two);
    const task = (await fetchTask(runner, version)).task;
    if (!task) throw new Error("no task");
    // Offered again past the job's start window: the replay is not a new assignment.
    await at(runId, now(runId) + 31 * MIN);
    expect((await fetchTask(runner, version)).task?.id).toBe(task.id);
    await updateTask(runner, task.id);
    const runnerRow = () =>
      env.DIRECTORY.prepare("SELECT task_confirmed_at, expires_at FROM ci_runners WHERE id = ?")
        .bind(runner.id)
        .first<{ task_confirmed_at: number | null; expires_at: number | null }>();
    expect((await runnerRow())?.task_confirmed_at).not.toBeNull();
    // The other job is waiting, and still: no task, not unauthenticated.
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(runId)).toHaveLength(1);

    // The task ends; the end handler is reset once after its D1 effect and runs again later.
    let resets = 1;
    await inRun(runId, (r) => {
      r.hooks = {
        afterTaskEndCommit: () => {
          if (resets-- > 0) throw new Error("reset after the effect");
        },
      };
    });
    expect((await updateTask(runner, task.id, Result.SUCCESS)).state?.result).toBe(Result.SUCCESS);
    await drain(runId);
    const completedAt = await inRun(
      runId,
      (r) =>
        r.engine.rows<{ completed_at: number }>(
          "SELECT completed_at FROM run_instances WHERE task = 1",
        )[0]?.completed_at,
    );
    expect((await runnerRow())?.expires_at).toBe((completedAt ?? 0) + 10 * MIN);
    await advance(runId, 10 * MIN);
    const run = await inRun(runId, (r) => r.engine.run());
    expect(run?.task_end_acked).toBe(run?.task_end_seq);
    expect((await runnerRow())?.expires_at).toBe((completedAt ?? 0) + 10 * MIN);

    // Spent: its own task's reports only.
    await connectError(
      await runnerCall("FetchTask", new Uint8Array(), { credentials: runner }),
      "unauthenticated",
      401,
    );
    await connectError(
      await runnerCall(
        "Declare",
        encodeDeclareRequest({ version: "v6", labels: [], capabilities: [] }),
        {
          credentials: runner,
        },
      ),
      "unauthenticated",
      401,
    );
    expect((await updateTask(runner, task.id)).state?.result).toBe(Result.CANCELLED);
    // After its end, nothing.
    vi.setSystemTime((completedAt ?? 0) + 10 * MIN + 1);
    await connectError(await updateTaskRaw(runner, task.id), "unauthenticated", 401);
  });
});

describe("a job token", () => {
  it("reads its own repository over git, and nothing else anywhere", async () => {
    const f = await orgRepo();
    await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    const token = jobTokenOf(task);
    const read = await uploadPack(f, token);
    expect(read.status).toBe(200);
    expect(await text(read)).toContain("packfile");
    // Another repository of the same owner: not found.
    const other = await json<{ name: string }>(
      api("POST", `/orgs/${f.org.login}/repos`, f.owner.token, { name: uniqueId("r") }),
    );
    expect(
      (
        await exports.default.fetch(
          `${ORIGIN}/${f.org.login}/${other.body.name}.git/info/refs?service=git-upload-pack`,
          {
            headers: { Authorization: basic(token), "Git-Protocol": "version=2" },
          },
        )
      ).status,
    ).toBe(404);
    // No push.
    const advertise = await exports.default.fetch(
      `${ORIGIN}/${f.org.login}/${f.repo.name}.git/info/refs?service=git-receive-pack`,
      { headers: { Authorization: basic(token) } },
    );
    expect(advertise.status).toBe(401);
    const push = await exports.default.fetch(
      `${ORIGIN}/${f.org.login}/${f.repo.name}.git/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: basic(token),
        },
        body: "0000",
      },
    );
    expect(push.status).toBe(401);
    // No REST, MCP or git token minting.
    for (const [method, path] of [
      ["GET", "/user"],
      ["GET", `/repos/${f.org.login}/${f.repo.name}`],
      ["GET", `/repos/${f.org.login}/${f.repo.name}/raw/a.txt`],
      ["POST", "/user/git-tokens"],
    ] as const)
      expect(
        (await api(method, path, token, method === "POST" ? {} : undefined)).status,
        path,
      ).toBe(401);
    const mcp = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    // Still good for git after all that.
    expect((await uploadPack(f, token)).status).toBe(200);
  });

  it("stops at once when its task completes, on an isolate that used it, before the end handler runs", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    const token = jobTokenOf(task);
    expect((await uploadPack(f, token)).status).toBe(200);
    expect(
      (
        await runStub(runId).completeTask(
          { jobId: (await jobNamed(runId, "a")).jobId, task: 1 },
          { result: "success", logComplete: false },
        )
      ).ok,
    ).toBe(true);
    // The end handler has not run: the token row is not revoked, the task decides.
    expect((await jobTokensOf(task.id))[0]?.revoked_at).toBeNull();
    expect((await uploadPack(f, token)).status).toBe(401);
    // Then the handler revokes it and ends the task row.
    await drain(runId);
    expect((await jobTokensOf(task.id))[0]?.revoked_at).not.toBeNull();
    expect((await taskRow(task.id))?.ended_at).not.toBeNull();
  });

  it("stops at once on a forced completion while the end handler is held", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    const token = jobTokenOf(task);
    expect((await uploadPack(f, token)).status).toBe(200);
    const held = gate();
    await inRun(runId, (r) => {
      r.hooks = { beforeTaskEnd: () => held.hold() };
    });
    await runStub(runId).cancel(f.owner.principalId, "force");
    const draining = drain(runId);
    await held.started;
    expect((await uploadPack(f, token)).status).toBe(401);
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    held.release();
    await draining;
    expect((await jobTokensOf(task.id))[0]?.revoked_at).not.toBeNull();
  });

  it("answers 503 with no pack data when the run cannot say whether its task is live", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    await inRun(runId, (r) => {
      r.hooks = {
        onTaskLive: () => {
          throw new Error("the run object is unavailable");
        },
      };
    });
    const res = await uploadPack(f, jobTokenOf(task));
    expect(res.status).toBe(503);
    expect(await text(res)).not.toContain("packfile");
  });

  it("answers 503 with no pack data when the task mapping lookup fails", async () => {
    const f = await orgRepo();
    await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    const database = new Proxy(env.DIRECTORY, {
      get(target, prop) {
        if (prop === "withSession")
          return (constraint?: D1SessionConstraint | D1SessionBookmark) => {
            const session = target.withSession(constraint);
            return new Proxy(session, {
              get(source, key) {
                if (key === "prepare")
                  return (sql: string) => {
                    if (sql.includes("FROM ci_job_tokens j JOIN ci_tasks"))
                      throw new Error("task mapping unavailable");
                    return source.prepare(sql);
                  };
                const value = Reflect.get(source, key);
                return typeof value === "function" ? value.bind(source) : value;
              },
            });
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await call(
      `/${f.org.login}/${f.repo.name}.git/git-upload-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
          Authorization: basic(jobTokenOf(task)),
        },
        body: fetchBody([`want ${f.sha}`, "done"]),
      },
      { DIRECTORY: database },
    );
    expect(res.status).toBe(503);
    expect(await text(res)).not.toContain("packfile");
  });

  it("minted while its task is force-cancelled is revoked before the answer, and refused even unrevoked", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const held = gate();
    let token = "";
    await inRun(runId, (r) => {
      r.hooks = {
        afterMint: async (minted) => {
          token = minted;
          await held.hold();
        },
      };
    });
    const fetching = fetchTask(runner, 0);
    await held.started;
    await runStub(runId).cancel(f.owner.principalId, "force");
    held.release();
    expect((await fetching).task).toBeUndefined();
    const [row] = await tasksOfRun(runId);
    expect(row?.ended_at).not.toBeNull();
    const [minted] = await jobTokensOf(row?.id ?? 0);
    expect(minted).toBeDefined();
    expect(typeof minted?.revoked_at).toBe("number");
    // Had the revocation been skipped, the task's end would still refuse it.
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = NULL WHERE id = ?")
      .bind(minted?.id ?? "")
      .run();
    expect((await uploadPack(f, token)).status).toBe(401);
  });

  it.each(["cancel", "lookup failure"] as const)(
    "handles %s during the triggering actor lookup",
    async (mode) => {
      const f = await orgRepo();
      const runId = await started(f, one);
      const runner = await registerRunner(f.org.login, f.owner);
      const held = gate();
      let original!: D1Database;
      await inRun(runId, (r) => {
        const host = r as unknown as { env: Env };
        original = host.env.DIRECTORY;
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(target, key) {
              if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
              if (key === "first")
                return async () => {
                  await held.hold();
                  if (mode === "lookup failure") throw new Error("display lookup unavailable");
                  return target.first();
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        Object.defineProperty(host.env, "DIRECTORY", {
          configurable: true,
          value: new Proxy(original, {
            get(target, key) {
              if (key === "prepare")
                return (sql: string) => {
                  const statement = target.prepare(sql);
                  return sql.includes("AS handle FROM principals p WHERE p.id")
                    ? wrap(statement)
                    : statement;
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        });
      });
      const fetching = fetchTask(runner, 0);
      let answer: Awaited<typeof fetching> | undefined;
      try {
        await Promise.race([
          held.started,
          fetching.then(() => {
            throw new Error("assignment finished before the triggering actor lookup");
          }),
        ]);
        if (mode === "cancel") await runStub(runId).cancel(f.owner.principalId, "force");
      } finally {
        held.release();
        try {
          answer = await fetching;
        } finally {
          await inRun(runId, (r) => {
            Object.defineProperty((r as unknown as { env: Env }).env, "DIRECTORY", {
              configurable: true,
              value: original,
            });
          });
        }
      }
      expect(answer?.task === undefined).toBe(mode === "cancel");
      const [row] = await tasksOfRun(runId);
      const [minted] = await jobTokensOf(row?.id ?? 0);
      expect(minted).toBeDefined();
      if (mode === "cancel") expect(typeof minted?.revoked_at).toBe("number");
      else {
        expect(minted?.revoked_at).toBeNull();
        expect(answer?.task?.context?.triggering_actor).toBe("");
      }
    },
  );

  it("whose task is force-cancelled after the final ownership lookup, is never handed out", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    const held = gate();
    await inRun(runId, (r) => {
      r.hooks = { beforeTaskAnswer: () => held.hold() };
    });
    const fetching = fetchTask(runner, 0);
    await held.started;
    await runStub(runId).cancel(f.owner.principalId, "force");
    held.release();
    expect((await fetching).task).toBeUndefined();
    const [row] = await tasksOfRun(runId);
    const [minted] = await jobTokensOf(row?.id ?? 0);
    expect(minted).toBeDefined();
    expect(typeof minted?.revoked_at).toBe("number");
  });

  it("of an agent is no OAuth exchange subject", async () => {
    const f = await orgRepo();
    const agent = await agentFor(f.owner, ["contents:read"]);
    await started(f, one, { actor: agent.id });
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    const res = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: jobTokenOf(task),
        subject_token_type: ACCESS_TOKEN_TYPE,
        grant_id: agent.grantId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("of an agent whose organization requires DPoP is taken by git without a proof", async () => {
    const f = await orgRepo();
    expect(
      (await json(api("PATCH", `/orgs/${f.org.login}`, f.owner.token, { require_dpop: true })))
        .status,
    ).toBe(200);
    const agent = await json<{ id: string; handle: string }>(
      api("POST", "/agents", f.owner.token, {
        handle: uniqueId("bot").slice(0, 39),
        org: f.org.login,
      }),
    );
    expect(agent.status).toBe(201);
    await started(f, one, { actor: agent.body.id });
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    const token = jobTokenOf(task);
    // Taken (no proof asked for), then judged on the agent's own access to the repository,
    // which it has none of here: as for the agent's git token, not found rather than refused.
    const res = await uploadPack(f, token);
    expect(res.status).toBe(404);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    // The API would ask for a proof; it refuses the job token anyway.
    expect((await api("GET", "/user", token)).status).toBe(401);
  });
});

describe("the runner protocol answers", () => {
  it("UpdateTask from a user token is no runner call", async () => {
    const owner = await user();
    const res = await call("/api/actions/runner.v1.RunnerService/UpdateTask", {
      method: "POST",
      headers: { "content-type": "application/proto", Authorization: `Bearer ${owner.token}` },
      body: new Uint8Array(),
    });
    await connectError(res, "unauthenticated", 401);
  });
});
