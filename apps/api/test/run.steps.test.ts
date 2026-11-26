// A job's steps as its runner reports them: kept with the job at the writes
// its heartbeats and completion make anyway, named as the workflow writes
// them, and listed with the job.
import { describe, expect, it } from "vitest";
import { jobSteps, MAX_JOB_STEPS, MAX_NAME_UNITS, storedSteps } from "../src/do/run/steps.js";
import { Result, StepStage, type StepState } from "../src/runner/proto/messages.js";
import { api, json } from "./helpers/api.js";
import { encodeUpdateLogRequest, encodeUpdateTaskRequest } from "./helpers/runner-proto.js";
import {
  type Credentials,
  fetchTask,
  orgRepo,
  proto,
  registerRunner,
  runnerCall,
  stateOf,
} from "./helpers/runners.js";
import { at, drain, inRun, started, T0, workflow } from "./helpers/runs.js";

const JOB = [
  "  a:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow's expression.
  "      - name: Build ${{ secrets.NAME }}",
  "        run: make",
  "      - run: |",
  "          echo one",
  "          echo two",
].join("\n");

const time = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const reported = (stage: number, number: number, more: Partial<StepState> = {}): StepState => ({
  id: 0,
  result: Result.UNSPECIFIED,
  logIndex: 0,
  logLength: 0,
  name: "what the runner calls it",
  stage,
  number,
  ...more,
});

async function withTask() {
  const f = await orgRepo();
  const runId = await started(f, workflow(JOB));
  const runner = await registerRunner(f.org.login, f.owner);
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no task");
  await inRun(runId, (run) => run.engine.exec("UPDATE run_instances SET heartbeat_at = 0"));
  return { f, runId, runner, wire: task.id };
}
type Task = Awaited<ReturnType<typeof withTask>>;

async function report(
  t: { runner: Credentials; wire: number },
  steps: Partial<Record<"steps" | "reportedSteps", StepState[]>>,
  result: number = Result.UNSPECIFIED,
) {
  await proto(
    await runnerCall(
      "UpdateTask",
      encodeUpdateTaskRequest({
        state: { ...stateOf(t.wire, result), ...steps },
        outputs: new Map(),
      }),
      { credentials: t.runner },
    ),
  );
}

async function listed(t: Task) {
  const { body } = await json<{ jobs: { steps: unknown[] }[] }>(
    api("GET", `${t.f.path}/actions/runs/${t.runId}/jobs`, t.f.owner.token),
  );
  return body.jobs[0]?.steps as Record<string, unknown>[];
}

const START = Date.UTC(2026, 10, 25, 9);

describe("a job's steps", () => {
  it("are listed as the runner reported them last, named as the workflow writes them", async () => {
    const t = await withTask();
    expect(await listed(t)).toEqual([]);
    const all = [
      reported(StepStage.SETUP, 0, {
        result: Result.SUCCESS,
        startedAt: time(START),
        stoppedAt: time(START + 1_500),
        logLength: 4,
      }),
      reported(StepStage.PRE, 0, { result: Result.SKIPPED }),
      reported(StepStage.MAIN, 0, {
        startedAt: time(START + 1_500),
        logIndex: 4,
        logLength: 9,
      }),
      reported(StepStage.MAIN, 1),
      reported(StepStage.MAIN, 2),
      reported(StepStage.CLEANUP, 0),
    ];
    await report(t, { reportedSteps: all });
    expect(await listed(t)).toEqual([
      {
        number: 1,
        name: "Set up job",
        stage: "setup",
        status: "completed",
        conclusion: "success",
        started_at: START,
        completed_at: START + 1_500,
        log: { from: 0, rows: 4 },
      },
      expect.objectContaining({
        name: "Pre Run actions/checkout@v4",
        stage: "pre",
        status: "completed",
        conclusion: "skipped",
        started_at: null,
        log: null,
      }),
      expect.objectContaining({
        name: "Run actions/checkout@v4",
        stage: "main",
        status: "in_progress",
        conclusion: null,
        started_at: START + 1_500,
        completed_at: null,
        log: { from: 4, rows: 9 },
      }),
      expect.objectContaining({
        number: 4,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow's expression.
        name: "Build ${{ secrets.NAME }}",
        status: "queued",
      }),
      expect.objectContaining({ name: "Run echo one" }),
      expect.objectContaining({ number: 6, name: "Complete job", stage: "cleanup" }),
    ]);
    const one = await json<{ steps: unknown[] }>(
      api("GET", `${t.f.path}/actions/runs/${t.runId}/jobs/1`, t.f.owner.token),
    );
    expect(one.body.steps).toEqual(await listed(t));
    await report(
      t,
      {
        steps: [
          reported(0, 0, { id: 0, result: Result.SUCCESS, startedAt: time(START) }),
          reported(0, 0, { id: 1, startedAt: time(START) }),
          reported(0, 0, { id: 2 }),
        ],
      },
      Result.CANCELLED,
    );
    expect(
      (await listed(t)).map(({ name, status, conclusion }) => [name, status, conclusion]),
    ).toEqual([
      ["Run actions/checkout@v4", "completed", "success"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow's expression.
      ["Build ${{ secrets.NAME }}", "completed", "cancelled"],
      ["Run echo one", "completed", "skipped"],
    ]);
    const kept = await inRun(
      t.runId,
      (run) => run.engine.rows<{ steps: string }>("SELECT steps FROM run_instances")[0]?.steps,
    );
    expect(kept).not.toContain("runner");
  });

  it("cost no write besides the heartbeat's, whichever call makes it, and the completion's", async () => {
    const t = await withTask();
    await at(t.runId, T0);
    const step = (logLength: number) => ({
      reportedSteps: [reported(StepStage.SETUP, 0, { startedAt: time(START), logLength })],
    });
    const rows = async () => (await listed(t))[0]?.log;
    await inRun(t.runId, (run) => run.engine.exec("UPDATE run_instances SET heartbeat_at = ?", T0));
    await report(t, step(1));
    expect(await rows()).toBeUndefined();
    await at(t.runId, T0 + 30_000);
    await proto(
      await runnerCall(
        "UpdateLog",
        encodeUpdateLogRequest({ taskId: t.wire, index: 0, rows: [{ content: "x" }] }),
        { credentials: t.runner },
      ),
    );
    expect(await rows()).toEqual({ from: 0, rows: 1 });
    await report(t, step(2));
    expect(await rows()).toEqual({ from: 0, rows: 1 });
    await report(t, {}, Result.SUCCESS);
    expect(await rows()).toEqual({ from: 0, rows: 2 });
    await drain(t.runId);
  });

  it("end with the last reported, however the job ended", async () => {
    const t = await withTask();
    const setup = (result: number) => ({
      reportedSteps: [reported(StepStage.SETUP, 0, { startedAt: time(START), result })],
    });
    await report(t, setup(Result.UNSPECIFIED));
    await report(t, setup(Result.SUCCESS));
    await json(api("POST", `${t.f.path}/actions/runs/${t.runId}/force-cancel`, t.f.owner.token));
    await drain(t.runId);
    expect((await listed(t)).map((s) => s.conclusion)).toEqual(["success"]);
  });

  it("names a step no longer than a page of jobs can hold", () => {
    const name = "n".repeat(480_000);
    const [step] = jobSteps(
      storedSteps({ steps: [reported(0, 0)], reportedSteps: [] }),
      [{ kind: "run", name: { value: name }, run: { value: "x" } } as never],
      false,
    );
    expect(step?.name).toBe(name.slice(0, MAX_NAME_UNITS));
  });

  it("are gone with a task its run took back", async () => {
    const t = await withTask();
    await report(t, { steps: [reported(0, 0)] });
    expect(await listed(t)).toHaveLength(1);
    await inRun(t.runId, (run) => run.requeueTask({ jobId: 1, task: 1 }));
    expect(await listed(t)).toEqual([]);
  });

  it("are bounded and numbers only, whatever a runner reports", () => {
    const stored = storedSteps({
      steps: Array.from({ length: 2_000 }, (_, id) =>
        reported(0, 0, {
          id,
          result: 99,
          startedAt: { seconds: Number.MAX_SAFE_INTEGER, nanos: -1 },
          logIndex: 2 ** 60,
          logLength: Number.MAX_SAFE_INTEGER,
        }),
      ),
      reportedSteps: [reported(77, 1)],
    });
    const mixed = storedSteps({
      steps: [],
      reportedSteps: [reported(77, 0), reported(StepStage.SETUP, 0)],
    });
    expect(jobSteps(mixed, [], false).map((s) => s.stage)).toEqual(["setup"]);
    expect(stored?.length).toBeLessThan(16 * 1024);
    const steps = jobSteps(stored, [], false);
    expect(steps).toHaveLength(MAX_JOB_STEPS);
    expect(steps[0]).toEqual({
      number: 1,
      name: "Step",
      stage: "main",
      status: "queued",
      conclusion: null,
      startedAt: null,
      completedAt: null,
      log: { from: 0, rows: Number.MAX_SAFE_INTEGER },
    });
    expect(storedSteps({ steps: [], reportedSteps: [] })).toBeNull();
  });
});
