// UpdateTask: a runner's report on its task. The Worker reads at most
// 1.25 MiB and routes by the task id it scans, the task's run decodes the
// report, confirms the task once, heartbeats it or completes it with its
// outputs (up to 1 MiB; more fails the job), and answers with the result
// the runner should act on. The job token a task carries lives as long as
// the job may run, at most a day, and names the run's original actor.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { encodeTaskState, Result, type StepState } from "../src/runner/proto/messages.js";
import { Writer } from "../src/runner/proto/wire.js";
import { user } from "./helpers/api.js";
import { fetchBody } from "./helpers/fetch-repo.js";
import { basic, ORIGIN } from "./helpers/git-http.js";
import { decodeUpdateTaskResponse, encodeUpdateTaskRequest } from "./helpers/runner-proto.js";
import {
  connectError,
  fetchTask,
  jobTokenOf,
  jobTokensOf,
  orgRepo,
  proto,
  registerRunner,
  runnerCall,
  stateOf,
  taskRow,
  updateTask,
  updateTaskRaw,
} from "./helpers/runners.js";
import { drain, inRun, job, jobNamed, runStub, started, workflow } from "./helpers/runs.js";

const MIN = 60_000;
const one = workflow(job("a"));
const MiB = 1024 * 1024;

/** A run of `source` in a new organization, with a runner holding its first task. */
async function withTask(source = one, labels?: string[]) {
  const f = await orgRepo();
  const runId = await started(f, source);
  const runner = await registerRunner(f.org.login, f.owner, labels ? { labels } : {});
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no task");
  return { f, runId, runner, task };
}

const steps = (n: number): StepState[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    result: Result.SUCCESS,
    logIndex: i,
    logLength: 1,
    name: `step ${i}`,
    stage: 0,
    number: i,
  }));

/** One output whose JSON (`{"o":"…"}`) is exactly `bytes` long. */
const outputsOf = (bytes: number) => new Map([["o", "x".repeat(bytes - '{"o":""}'.length)]]);

const instanceOf = (runId: string) =>
  inRun(
    runId,
    (r) =>
      r.engine.rows<{
        status: string;
        conclusion: string | null;
        outputs: string | null;
        error: string | null;
        log_complete: number | null;
      }>(
        "SELECT status, conclusion, outputs, error, log_complete FROM run_instances WHERE task = 1",
      )[0],
  );

describe("UpdateTask", () => {
  it("confirms the task once and heartbeats it, answering no result while it runs", async () => {
    const { runner, task } = await withTask();
    const first = await updateTask(runner, task.id);
    expect(first).toEqual({ state: stateOf(task.id), sentOutputs: [] });
    const confirmed = (await taskRow(task.id))?.confirmed_at;
    expect(confirmed).not.toBeNull();
    await updateTask(runner, task.id);
    expect((await taskRow(task.id))?.confirmed_at).toBe(confirmed);
  });

  it("completes the task with its result and outputs, its log incomplete with no final log stored", async () => {
    const { runId, runner, task } = await withTask();
    const outputs = new Map([
      ["version", "1.2.3"],
      ["__proto__", "kept"],
    ]);
    const done = await updateTask(runner, task.id, Result.SUCCESS, outputs);
    expect(done.state).toMatchObject({ id: task.id, result: Result.SUCCESS });
    expect([...done.sentOutputs].sort()).toEqual(["__proto__", "version"]);
    const row = await instanceOf(runId);
    expect(row).toMatchObject({ status: "completed", conclusion: "success", log_complete: 0 });
    expect(Object.entries(JSON.parse(row?.outputs ?? "{}"))).toEqual([...outputs]);
    // A later report: the run has finished with it.
    expect((await updateTask(runner, task.id)).state?.result).toBe(Result.CANCELLED);
  });

  it("takes exactly 1 MiB of outputs with 1,000 steps; 1 MiB and a byte fails the job", async () => {
    const ok = await withTask();
    const body = encodeUpdateTaskRequest({
      state: { ...stateOf(ok.task.id, Result.SUCCESS), steps: steps(1_000) },
      outputs: outputsOf(MiB),
    });
    expect(body.length).toBeLessThan(1.25 * MiB);
    const answer = decodeUpdateTaskResponse(
      await proto(await runnerCall("UpdateTask", body, { credentials: ok.runner })),
    );
    expect(answer.state?.result).toBe(Result.SUCCESS);
    expect(answer.sentOutputs).toEqual(["o"]);
    const stored = await instanceOf(ok.runId);
    expect(stored?.conclusion).toBe("success");
    expect(new TextEncoder().encode(stored?.outputs ?? "").length).toBe(MiB);

    const over = await withTask();
    const refused = decodeUpdateTaskResponse(
      await proto(
        await runnerCall(
          "UpdateTask",
          encodeUpdateTaskRequest({
            state: { ...stateOf(over.task.id, Result.SUCCESS), steps: steps(1_000) },
            outputs: outputsOf(MiB + 1),
          }),
          { credentials: over.runner },
        ),
      ),
    );
    expect(refused.state?.result).toBe(Result.SUCCESS);
    expect(refused.sentOutputs).toEqual([]);
    const failed = await instanceOf(over.runId);
    expect(failed).toMatchObject({ conclusion: "failure", outputs: null });
    expect(failed?.error).toMatch(/^outputs_too_large/);
  });

  it("refuses a body over 1.25 MiB", async () => {
    const { runner, task } = await withTask();
    const body = encodeUpdateTaskRequest({
      state: stateOf(task.id, Result.SUCCESS),
      outputs: outputsOf(1.25 * MiB),
    });
    await connectError(
      await runnerCall("UpdateTask", body, { credentials: runner }),
      "resource_exhausted",
      429,
    );
  });

  it("refuses a task of another runner, an unknown task, a body naming no task, and a decoded id that differs from the routed one", async () => {
    const { f, runner, task } = await withTask();
    const other = await registerRunner(f.org.login, f.owner);
    await connectError(await updateTaskRaw(other, task.id), "permission_denied", 403);
    await connectError(await updateTaskRaw(runner, 2 ** 40), "not_found", 404);
    await connectError(
      await runnerCall("UpdateTask", encodeUpdateTaskRequest({ outputs: new Map() }), {
        credentials: runner,
      }),
      "invalid_argument",
      400,
    );
    // Two task states: the scan routes by the first, protobuf decodes the last.
    const twice = new Writer()
      .message(1, encodeTaskState(stateOf(task.id)))
      .message(1, encodeTaskState(stateOf(task.id + 1)))
      .finish();
    await connectError(
      await runnerCall("UpdateTask", twice, { credentials: runner }),
      "invalid_argument",
      400,
    );
    expect((await taskRow(task.id))?.confirmed_at).toBeNull();
  });

  it("refuses a result the protocol does not define", async () => {
    const { runner, task } = await withTask();
    await connectError(await updateTaskRaw(runner, task.id, 9), "invalid_argument", 400);
  });
});

describe("the job token", () => {
  it("expires at the job's timeout plus 10 minutes, at most a day after it is minted, and is refused after", async () => {
    const { f, task } = await withTask();
    const [short] = await jobTokensOf(task.id);
    expect((short?.expires_at ?? 0) - (short?.created_at ?? 0)).toBe((360 + 10) * MIN);

    const long = await withTask(workflow(job("a", ["timeout-minutes: 7200"])));
    const [capped] = await jobTokensOf(long.task.id);
    expect((capped?.expires_at ?? 0) - (capped?.created_at ?? 0)).toBe(24 * 60 * MIN);

    const read = (token: string) =>
      exports.default.fetch(`${ORIGIN}/${f.org.login}/${f.repo.name}.git/git-upload-pack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
          Authorization: basic(token),
        },
        body: fetchBody([`want ${f.sha}`, "done"]),
      });
    expect((await read(jobTokenOf(task))).status).toBe(200);
    vi.setSystemTime((short?.expires_at ?? 0) + 1);
    expect((await read(jobTokenOf(task))).status).toBe(401);
  });

  it("of a re-run names the run's original actor, not who re-ran it", async () => {
    const { f, runId } = await withTask();
    const rerunner = await user();
    await runStub(runId).cancel(f.owner.principalId, "force");
    await drain(runId);
    expect((await runStub(runId).rerun(rerunner.principalId)).ok).toBe(true);
    await drain(runId);
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("no task");
    expect((await jobNamed(runId, "a")).attempt).toBe(2);
    const [minted] = await jobTokensOf(task.id);
    expect(minted?.principal_id).toBe(f.owner.principalId);
    expect(
      await env.DIRECTORY.prepare("SELECT 1 FROM tokens WHERE principal_id = ? AND type = 'job'")
        .bind(rerunner.principalId)
        .first(),
    ).toBeNull();
  });
});
