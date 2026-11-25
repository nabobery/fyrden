// An assignment the run could not record in the directory: anything threw
// between the run's own assignment and the directory's answer. The run stores
// that its record failed, and settles it 30 seconds later by what the directory
// then says of the offer: never recorded, its job is queued again; recorded,
// everything is left alone. Such a failure never fails a job. Failures are
// injected through hooks, or by a trigger of the directory, and the run's clock
// is the test's. An assignment whose run object was reset is reported by the
// Worker that called it: a call that fails there stands in for one, with an
// eviction where the object's memory matters. Failed deliveries are in ci.secrets.recovery.test.ts.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunDO } from "../src/do/RunDO.js";
import {
  type AssignTaskAnswer,
  DELIVERY_RECOVERY_MS,
  RECORD_TASK_SQL,
  SUPERSEDE_SECOND_TASK_SQL,
} from "../src/do/run/dispatch.js";
import { RUN_JOB } from "../src/do/run/engine.js";
import {
  breakSecret,
  credentialOf,
  deliveries,
  down,
  type Failure,
  failuresOf,
  type Hooks,
  hooked,
  jobA,
  later,
  nothingDelivered,
  outcomesOf,
  reached,
  reading,
  recoveryJob,
  reservationOf,
  reset,
  setSecret,
  UNSPENT,
} from "./helpers/ci-recovery.js";
import { encodeFetchTaskRequest } from "./helpers/runner-proto.js";
import {
  connectError,
  fetchTask,
  gate,
  jobTokensOf,
  ON,
  type OrgFixture,
  orgRepo,
  pendingOf,
  type RegisteredRunner,
  registerRunner,
  runnerCall,
  taskRow,
  tasksOfRun,
} from "./helpers/runners.js";
import {
  advance,
  drain,
  inRun,
  job,
  jobsOf,
  now,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";
import { logs } from "./setup/log-capture.js";

const S = 1_000;
const MIN = 60 * S;
const ERROR = "secrets_unavailable: these secrets do not open: set them again (A)";

const plain = () => workflow(job("a"));

interface Made {
  f: OrgFixture;
  runner: RegisteredRunner;
  runId: string;
  value: string;
}

interface Unrecorded extends Made {
  wireId: number;
  jobId: number;
  task: number;
}

async function made(source = reading(), ephemeral = false): Promise<Made> {
  const f = await orgRepo();
  const value = await setSecret(f);
  const runner = await registerRunner(f.org.login, f.owner, { ephemeral });
  const runId = await started(f, source);
  return { f, runner, runId, value };
}

type Stub = DurableObjectStub<RunDO>;
type AssignArgs = Parameters<RunDO["assignTask"]>;

/**
 * Runs whose `assignTask` and `assignmentLost`, as the Worker calls them, are
 * `assign` and `lost`; what was reported to them.
 */
function runsWith(
  assign: (stub: Stub, runId: string, ...args: AssignArgs) => Promise<AssignTaskAnswer>,
  lost: (stub: Stub, wireId: number, jobId: number) => Promise<void> = async (stub, ...args) => {
    await stub.assignmentLost(...args);
  },
) {
  const reports: [number, number][] = [];
  let stubs = 0;
  const RUN = {
    getByName(runId: string) {
      stubs++;
      const stub = runStub(runId);
      // A stub that threw stays broken.
      let broken: unknown;
      return {
        assignTask: (...args: AssignArgs) =>
          assign(stub, runId, ...args).catch((error) => {
            broken = error;
            throw error;
          }),
        async assignmentLost(wireId: number, jobId: number) {
          if (broken) throw broken;
          reports.push([wireId, jobId]);
          await lost(stub, wireId, jobId);
        },
      };
    },
  } as unknown as Env["RUN"];
  return { overrides: { ...ON, RUN }, reports, stubs: () => stubs };
}

/** The Worker's report of a failed call never arrives: the run is left to its own catch. */
const unreported = () =>
  runsWith(
    async (stub, _runId, ...args) => await stub.assignTask(...args),
    async () => undefined,
  ).overrides;

/** A poll whose assignment fails: the runner is told to ask again. */
async function pollFails(
  runner: RegisteredRunner,
  options: { overrides?: Partial<Env>; background?: ExecutionContext } = {},
) {
  const res = await runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: 0 }), {
    credentials: runner,
    overrides: unreported(),
    ...options,
  });
  await connectError(res, "unavailable", 503);
}

/** The first offer's assignment throws, under `hooks`. */
async function failingIn(m: Made, hooks: Hooks): Promise<Unrecorded> {
  await hooked(m.runId, hooks);
  await pollFails(m.runner);
  await hooked(m.runId, {});
  const [offer] = await tasksOfRun(m.runId);
  const { jobId } = await jobA(m.runId);
  const [row] = await failuresOf(m.runId);
  if (!offer || !row) throw new Error("no failed record was stored");
  expect(row).toEqual({ wire_id: offer.id, job_id: jobId, task: row.task, error: "" });
  expect(await jobA(m.runId)).toMatchObject({ status: "in_progress" });
  return { ...m, wireId: offer.id, jobId, task: row.task };
}

/** The record threw without reaching the directory. */
const notRecorded = async (source?: string, ephemeral?: boolean) =>
  failingIn(await made(source, ephemeral), { beforeTaskRecord: down });

/** The whole batch committed, and then threw. */
const committed = async (source?: string, ephemeral?: boolean) =>
  failingIn(await made(source, ephemeral), { afterTaskRecord: down });

const assignAgain = (p: Unrecorded) =>
  runStub(p.runId).assignTask(p.wireId, p.jobId, p.runner.id, p.f.org.id);

const giveUp = (wireId: number) =>
  env.DIRECTORY.prepare("UPDATE ci_tasks SET superseded_at = 5 WHERE id = ?").bind(wireId).run();

/** What `refuseTask` writes for an attempt that found its own task finished. */
const refusedFinished = (wireId: number) =>
  env.DIRECTORY.prepare("UPDATE ci_tasks SET ended_at = 1 WHERE id = ?").bind(wireId).run();

const recordedAt = (runId: string) =>
  inRun(
    runId,
    (r) =>
      r.engine.rows<{ recorded_at: number }>("SELECT recorded_at FROM ci_delivery_failures")[0]
        ?.recorded_at,
  );

const nextRunAt = (runId: string) =>
  inRun(
    runId,
    (r) =>
      r.engine.rows<{ state: string; next_run_at: number }>(
        "SELECT state, next_run_at FROM jobs WHERE job_id = ?",
        RUN_JOB.delivery,
      )[0],
  );

const queuedAt = (p: Unrecorded) =>
  inRun(p.runId, (r) => r.engine.instance(p.jobId)?.queued_at ?? null);

async function expectQueued(p: Unrecorded) {
  const a = await jobA(p.runId);
  expect(a).toMatchObject({ status: "queued" });
  expect(await failuresOf(p.runId)).toEqual([]);
  expect(await reservationOf(p.runId)).toEqual({ state: "reserved", started_at: null });
  expect((await taskRow(p.wireId))?.task).toBeNull();
  await nothingDelivered(p.f, p.runId);
}

async function expectKept(p: Unrecorded) {
  expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
  expect(await failuresOf(p.runId)).toEqual([]);
  expect(await reservationOf(p.runId)).toMatchObject({ state: "running" });
  expect(await taskRow(p.wireId)).toMatchObject({
    task: p.task,
    ended_at: null,
    superseded_at: null,
  });
}

/** The delivery of the offer fails too, under `hooks`, unsettled. */
async function deliveryFails(p: Unrecorded, hooks: Hooks) {
  await breakSecret(p.f);
  await hooked(p.runId, hooks);
  expect(await assignAgain(p)).toEqual({ refused: "secrets_undeliverable" });
  await hooked(p.runId, {});
}

/** The end of the offer commits, and its answer is lost. */
const endUnanswered = (wireId: number) => async () => {
  await env.DIRECTORY.prepare("UPDATE ci_tasks SET ended_at = 1 WHERE id = ? AND task IS NULL")
    .bind(wireId)
    .run();
  throw new Error("the answer was lost");
};

afterEach(() => {
  vi.restoreAllMocks();
});

const KINDS: [string, () => string, boolean][] = [
  ["with secrets", reading, false],
  ["without secrets", plain, false],
  ["with secrets, on an ephemeral runner", reading, true],
  ["without secrets, on an ephemeral runner", plain, true],
];

describe("a record that threw without committing", () => {
  it.each(KINDS)("%s: its job is queued again 30 s later, and delivered once", async (...kind) => {
    const [, source, ephemeral] = kind;
    const p = await notRecorded(source(), ephemeral);
    const queued = await queuedAt(p);
    await advance(p.runId, DELIVERY_RECOVERY_MS - 1);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    expect((await taskRow(p.wireId))?.superseded_at).toBeNull();
    await advance(p.runId, 1);
    await expectQueued(p);
    expect(await taskRow(p.wireId)).toMatchObject({
      ended_at: null,
      superseded_at: expect.any(Number),
    });
    expect(await queuedAt(p)).toBe(queued);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "requeued"]);
    expect(await credentialOf(p.runner)).toEqual(UNSPENT);
    expect((await recoveryJob(p.runId))?.state).toBe("done");

    const task = (await fetchTask(p.runner, 0)).task;
    expect(task?.id).not.toBe(p.wireId);
    const secret = source === reading;
    expect(task?.secrets.get("A")).toBe(secret ? p.value : undefined);
    expect((await deliveries(p.f)).map((d) => d.task_id)).toEqual(secret ? [task?.id] : []);
    expect((await fetchTask(p.runner, 0)).task).toBeUndefined();
    expect(await jobTokensOf(p.wireId)).toEqual([]);
    await later(p.runId);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    expect(await tasksOfRun(p.runId)).toHaveLength(2);
  });

  it("by a directory that refused the write: no audit row either", async () => {
    const m = await made();
    const trigger = `refuse_${m.runId}`;
    await env.DIRECTORY.prepare(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE OF task ON ci_tasks WHEN NEW.run_id = '${m.runId}'
         BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    ).run();
    let p: Unrecorded;
    try {
      p = await failingIn(m, {});
      expect(await deliveries(p.f)).toEqual([]);
    } finally {
      await env.DIRECTORY.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    await later(p.runId);
    await expectQueued(p);
    expect((await fetchTask(p.runner, 0)).task?.secrets.get("A")).toBe(p.value);
    expect(await deliveries(p.f)).toHaveLength(1);
  });

  it("is on disk: a reset changes nothing", async () => {
    const p = await notRecorded();
    await reset(p.runId);
    await later(p.runId);
    await expectQueued(p);
  });

  it("is told to every runner of its account", async () => {
    const p = await notRecorded();
    await drain(p.runId);
    expect(await pendingOf(p.runId)).toEqual([]);
    await later(p.runId);
    expect((await pendingOf(p.runId)).map((r) => [r.job_id, r.claimed_by])).toEqual([
      [p.jobId, null],
    ]);
  });

  it("throws its own error when the failure cannot be stored either", async () => {
    const m = await made();
    await inRun(m.runId, (r) => {
      r.hooks = { beforeTaskRecord: down };
      const ensure = r.jobs.ensure.bind(r.jobs);
      vi.spyOn(r.jobs, "ensure").mockImplementation((kind, ...rest) => {
        if (kind === "ci_delivery") throw new Error("the row could not be stored");
        return ensure(kind, ...rest);
      });
    });
    await pollFails(m.runner);
    expect(
      logs.entries().filter((e) => e.msg === "task assignment failed" && e.runId === m.runId),
    ).toEqual([expect.objectContaining({ error: "the directory write failed" })]);
    expect(await failuresOf(m.runId)).toEqual([]);
  });

  it("is delivered when its offer is made again first: the recovery keeps it", async () => {
    const p = await notRecorded();
    expect(await assignAgain(p)).toHaveProperty("task");
    const tokens = await jobTokensOf(p.wireId);
    await later(p.runId);
    await expectKept(p);
    expect(await jobTokensOf(p.wireId)).toEqual(tokens);
    expect(tokens.map((t) => t.revoked_at)).toEqual([null]);
    expect(await deliveries(p.f)).toHaveLength(1);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "kept_recorded"]);
  });
});

describe("a throw before the record", () => {
  it("while the secrets are masked: its job is queued again", async () => {
    const p = await failingIn(await made(), { beforeSecretMasks: down });
    await later(p.runId);
    await expectQueued(p);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "requeued"]);
  });

  it("before anything is assigned stores nothing", async () => {
    const m = await made();
    await inRun(m.runId, (r) => {
      vi.spyOn(r, "assign").mockImplementation(() => {
        throw new Error("not assigned");
      });
    });
    await pollFails(m.runner);
    expect(await failuresOf(m.runId)).toEqual([]);
    expect(await recoveryJob(m.runId)).toBeUndefined();
    expect(await jobA(m.runId)).toMatchObject({ status: "queued" });
  });
});

describe("a refused record", () => {
  it("whose job could not be queued again at once is queued again by the recovery", async () => {
    const m = await made();
    await inRun(m.runId, (r) => {
      r.hooks = {
        beforeTaskRecord: async () => {
          const [offer] = await tasksOfRun(m.runId);
          if (offer) await giveUp(offer.id);
        },
      };
      vi.spyOn(r, "requeueTask").mockImplementationOnce(() => {
        throw new Error("not queued");
      });
    });
    const p = await failingIn(m, await inRun(m.runId, (r) => r.hooks));
    await later(p.runId);
    await expectQueued(p);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "requeued"]);
  });

  it("settled at once stores nothing", async () => {
    const m = await made();
    await hooked(m.runId, {
      beforeTaskRecord: async () => {
        const [offer] = await tasksOfRun(m.runId);
        if (offer) await giveUp(offer.id);
      },
    });
    await fetchTask(m.runner, 0);
    expect(await jobA(m.runId)).toMatchObject({ status: "queued" });
    expect(await failuresOf(m.runId)).toEqual([]);
    expect(await recoveryJob(m.runId)).toBeUndefined();
  });
});

describe("a record that committed and then threw", () => {
  it.each(KINDS)("%s: everything is left alone", async (...kind) => {
    const [, source, ephemeral] = kind;
    const p = await committed(source(), ephemeral);
    const offer = await taskRow(p.wireId);
    const credential = await credentialOf(p.runner);
    const audited = await deliveries(p.f);
    expect(offer).toMatchObject({ task: p.task, ended_at: null, superseded_at: null });
    if (ephemeral) expect(credential?.task_assigned_at).not.toBeNull();
    expect(audited).toHaveLength(source === reading ? 1 : 0);
    await later(p.runId);
    await expectKept(p);
    expect(await taskRow(p.wireId)).toEqual(offer);
    expect(await credentialOf(p.runner)).toEqual(credential);
    expect(await deliveries(p.f)).toEqual(audited);
    expect(await jobTokensOf(p.wireId)).toEqual([]);
    expect(await pendingOf(p.runId)).toEqual([]);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "kept_recorded"]);
    // Nobody runs it: the heartbeat deadline ends it, as before.
    await advance(p.runId, 10 * MIN);
    expect(await jobA(p.runId)).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(await tasksOfRun(p.runId)).toHaveLength(1);
  });

  it("an error after the directory's answer: the run stores nothing of its own", async () => {
    const m = await made();
    await hooked(m.runId, { afterMint: down });
    await pollFails(m.runner);
    expect(await failuresOf(m.runId)).toEqual([]);
    expect(await recoveryJob(m.runId)).toBeUndefined();
  });
});

describe("an attempt held before its record", () => {
  /** Another attempt of the offer, held there, while `fn` runs. */
  async function holding(p: Unrecorded, fn: (finish: () => Promise<unknown>) => Promise<void>) {
    const held = gate();
    await hooked(p.runId, { beforeTaskRecord: () => held.hold() });
    const slow = assignAgain(p);
    try {
      await reached(held, slow);
      await hooked(p.runId, {});
      await fn(() => {
        held.release();
        return slow;
      });
    } finally {
      held.release();
      await Promise.allSettled([slow]);
    }
  }

  it.each([false, true])(
    "that commits only after the recovery gave its offer up records nothing (ephemeral: %s)",
    async (ephemeral) => {
      const p = await notRecorded(reading(), ephemeral);
      await holding(p, async (finish) => {
        await later(p.runId);
        await expectQueued(p);
        const rev = await inRun(p.runId, (r) => r.engine.run()?.queue_rev);
        expect(await finish()).toEqual({ refused: "released" });
        await expectQueued(p);
        expect(await inRun(p.runId, (r) => r.engine.run()?.queue_rev)).toBe(rev);
        expect(await credentialOf(p.runner)).toEqual(UNSPENT);
      });
    },
  );

  it("leaves the task the job was given meanwhile running, its token valid", async () => {
    const p = await notRecorded();
    await holding(p, async (finish) => {
      await later(p.runId);
      const other = await registerRunner(p.f.org.login, p.f.owner);
      const task = (await fetchTask(other, 0)).task;
      if (!task) throw new Error("not delivered");
      expect(await finish()).toEqual({ refused: "released" });
      await later(p.runId);
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      expect((await jobTokensOf(task.id)).map((t) => t.revoked_at)).toEqual([null]);
      expect(await deliveries(p.f)).toHaveLength(1);
    });
  });

  it("that also throws: one row, settled 30 s after the first", async () => {
    const p = await notRecorded();
    const at = await recordedAt(p.runId);
    await advance(p.runId, 20 * S);
    await hooked(p.runId, { beforeTaskRecord: down });
    await assignAgain(p).catch(() => undefined);
    await hooked(p.runId, {});
    expect(await failuresOf(p.runId)).toHaveLength(1);
    expect(await recordedAt(p.runId)).toBe(at);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled"]);
    await advance(p.runId, 10 * S);
    await expectQueued(p);
  });
});

describe("an ephemeral runner's second offer, whose record threw", () => {
  it.each(["the record", "the recovery"])("given up by %s: its job is queued again", async (by) => {
    const p = await notRecorded(reading(), true);
    await drain(p.runId);
    vi.setSystemTime(Date.now() + 31 * S);
    await started(p.f, workflow(job("other")));
    expect((await fetchTask(p.runner, 0)).task).toBeDefined();
    const credential = await credentialOf(p.runner);
    expect(credential?.task_assigned_at).not.toBeNull();
    if (by === "the record")
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare(RECORD_TASK_SQL).bind(p.task, p.wireId),
        env.DIRECTORY.prepare(SUPERSEDE_SECOND_TASK_SQL).bind(p.wireId, 5),
      ]);
    await later(p.runId);
    await expectQueued(p);
    expect(await credentialOf(p.runner)).toEqual(credential);
  });
});

describe("a failed record against a failed delivery", () => {
  it.each(["ended", "not ended"])(
    "after it, on the same task (its offer %s): the delivery's error and time are kept",
    async (how) => {
      const p = await notRecorded();
      await deliveryFails(p, {
        beforeDeliveryFailure: how === "ended" ? endUnanswered(p.wireId) : down,
      });
      const [row] = await failuresOf(p.runId);
      expect(row).toMatchObject({ task: p.task, error: ERROR });
      const at = await recordedAt(p.runId);
      const job = await nextRunAt(p.runId);
      await advance(p.runId, 5 * S);
      await setSecret(p.f, p.value);
      await hooked(p.runId, { beforeSecretMasks: down });
      await assignAgain(p).catch(() => undefined);
      await hooked(p.runId, {});
      expect(await failuresOf(p.runId)).toEqual([row]);
      expect(await recordedAt(p.runId)).toBe(at);
      expect(await nextRunAt(p.runId)).toEqual(job);
      await later(p.runId);
      expect(await failuresOf(p.runId)).toEqual([]);
      const [only] = await jobsOf(p.runId);
      if (how === "ended") expect(only).toMatchObject({ conclusion: "failure", error: ERROR });
      else expect(only).toMatchObject({ status: "queued", error: null });
    },
  );

  it("before it: the delivery's error replaces it, and fails the job", async () => {
    const p = await notRecorded();
    await advance(p.runId, 20 * S);
    await deliveryFails(p, { beforeDeliveryFailure: endUnanswered(p.wireId) });
    expect(await failuresOf(p.runId)).toEqual([
      { wire_id: p.wireId, job_id: p.jobId, task: p.task, error: ERROR },
    ]);
    await advance(p.runId, 10 * S);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    await later(p.runId);
    const [only] = await jobsOf(p.runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure", error: ERROR });
  });

  it.each(["record", "delivery"])(
    "that fails while the recovery of a failed %s awaits the directory is settled by a later answer",
    async (first) => {
      const p = await notRecorded();
      if (first === "delivery") await deliveryFails(p, { beforeDeliveryFailure: down });
      else await breakSecret(p.f);
      await hooked(p.runId, {
        // The recovery has given the offer up; its answer is not acted on yet.
        afterDeliveryRecovery: async () => {
          await hooked(p.runId, { beforeDeliveryFailure: endUnanswered(p.wireId) });
          expect(await assignAgain(p)).toEqual({ refused: "secrets_undeliverable" });
          await hooked(p.runId, {});
        },
      });
      await later(p.runId);
      expect(await failuresOf(p.runId)).toEqual([
        { wire_id: p.wireId, job_id: p.jobId, task: p.task, error: ERROR },
      ]);
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      await later(p.runId);
      const [only] = await jobsOf(p.runId);
      expect(only).toMatchObject({ status: "completed", conclusion: "failure", error: ERROR });
      expect(await failuresOf(p.runId)).toEqual([]);
      await nothingDelivered(p.f, p.runId);
    },
  );

  it.each(["given up and ended", "ended"])(
    "of a task queued again: the newer task's is stored, and its offer, %s by the older's refusal, fails no job",
    async (how) => {
      const p = await notRecorded();
      // The job goes back to the queue without its row: a refused record's requeue does that.
      await giveUp(p.wireId);
      expect(await assignAgain(p)).toEqual({ refused: "released" });
      expect((await failuresOf(p.runId)).map((r: Failure) => r.task)).toEqual([p.task]);
      if (how === "ended")
        await env.DIRECTORY.prepare("UPDATE ci_tasks SET superseded_at = NULL WHERE id = ?")
          .bind(p.wireId)
          .run();
      await advance(p.runId, 5 * S);
      await hooked(p.runId, { beforeTaskRecord: down });
      await assignAgain(p).catch(() => undefined);
      await hooked(p.runId, {});
      const [row] = await failuresOf(p.runId);
      expect(row).toEqual({
        wire_id: p.wireId,
        job_id: p.jobId,
        task: expect.any(Number),
        error: "",
      });
      expect(row?.task).not.toBe(p.task);
      expect(await recordedAt(p.runId)).toBe(now(p.runId));
      await refusedFinished(p.wireId);
      await later(p.runId);
      const [only] = await jobsOf(p.runId);
      expect(only).toMatchObject({ status: "queued", error: null });
      expect(await failuresOf(p.runId)).toEqual([]);
      expect(outcomesOf(p.wireId).at(-1)).toBe("requeued");
      expect((await fetchTask(p.runner, 0)).task?.secrets.get("A")).toBe(p.value);
    },
  );

  it("whose offer is gone: its job is queued again", async () => {
    const p = await notRecorded();
    await env.DIRECTORY.prepare("DELETE FROM ci_tasks WHERE id = ?").bind(p.wireId).run();
    await later(p.runId);
    expect(await jobA(p.runId)).toMatchObject({ status: "queued", error: null });
    expect(await failuresOf(p.runId)).toEqual([]);
  });
});

describe("a directory that does not answer the recovery of a failed record", () => {
  it("is asked again at its back-off, not earlier for another throw", async () => {
    const p = await notRecorded();
    await hooked(p.runId, { beforeDeliveryRecovery: down });
    await later(p.runId);
    for (let wait = 1; wait <= 32; wait *= 2) await advance(p.runId, wait * S);
    const due = await nextRunAt(p.runId);
    expect(due).toMatchObject({ state: "queued" });
    expect((due?.next_run_at ?? 0) - now(p.runId)).toBeGreaterThan(DELIVERY_RECOVERY_MS);
    await hooked(p.runId, { beforeTaskRecord: down, beforeDeliveryRecovery: down });
    await assignAgain(p).catch(() => undefined);
    expect(await nextRunAt(p.runId)).toEqual(due);
    await hooked(p.runId, {});
    await advance(p.runId, MIN + 4 * S);
    await expectQueued(p);
  });
});

describe("a run that ends meanwhile", () => {
  const left = (runId: string) =>
    inRun(runId, (r) => ({
      rows: r.engine.rows("SELECT 1 FROM ci_delivery_failures").length,
      jobs: r.engine.rows<{ kind: string }>("SELECT kind FROM jobs").map((j) => j.kind),
    }));

  it("erased before the throw: nothing is stored", async () => {
    const m = await made();
    await hooked(m.runId, {
      beforeTaskRecord: async () => {
        await runStub(m.runId).erase(m.f.repo.id);
        down();
      },
    });
    await pollFails(m.runner);
    expect(await left(m.runId)).toEqual({ rows: 0, jobs: ["run_log_purge"] });
  });

  it("erased after it: no row and no recovery is left", async () => {
    const p = await notRecorded();
    await inRun(p.runId, (r) => r.erase(p.f.repo.id));
    await later(p.runId);
    expect((await left(p.runId)).rows).toBe(0);
    expect((await taskRow(p.wireId))?.superseded_at).toBeNull();
  });

  it("force-cancelled before the throw: nothing is stored", async () => {
    const m = await made();
    await hooked(m.runId, {
      beforeTaskRecord: async () => {
        await runStub(m.runId).cancel(m.f.owner.principalId, "force");
        down();
      },
    });
    await pollFails(m.runner);
    expect(await failuresOf(m.runId)).toEqual([]);
    expect(await recoveryJob(m.runId)).toBeUndefined();
  });

  it.each(["force", "graceful"] as const)(
    "cancelled (%s) after it: nothing goes back to the queue",
    async (mode) => {
      const p = await notRecorded();
      await runStub(p.runId).cancel(p.f.owner.principalId, mode);
      await later(p.runId);
      expect(await failuresOf(p.runId)).toEqual([]);
      await advance(p.runId, 3 * MIN);
      expect(await jobA(p.runId)).toMatchObject({ status: "completed", conclusion: "cancelled" });
      expect(await pendingOf(p.runId)).toEqual([]);
      await nothingDelivered(p.f, p.runId);
    },
  );
});

describe("an assignment the Worker's call of failed", () => {
  const wasReset = (more: object = {}) =>
    Object.assign(new Error("the run object was reset"), { remote: true, ...more });

  /** A poll whose assignment ran as `assign` and failed, reported. */
  async function lostCall(
    m: Made,
    assign: (stub: Stub, runId: string, ...args: AssignArgs) => Promise<never>,
  ): Promise<Unrecorded> {
    const runs = runsWith(assign);
    await pollFails(m.runner, { overrides: runs.overrides });
    const [offer] = await tasksOfRun(m.runId);
    const { jobId } = await jobA(m.runId);
    if (!offer) throw new Error("no offer");
    expect(runs.reports).toEqual([[offer.id, jobId]]);
    const task = await inRun(m.runId, (r) => r.engine.instance(jobId)?.task);
    return { ...m, wireId: offer.id, jobId, task: task ?? 0 };
  }

  /** The object was reset after it assigned the job, before it asked the directory to record it. */
  const resetBeforeRecord = async (_: Stub, runId: string, ...args: AssignArgs) => {
    const [wireId, jobId, , accountId] = args;
    const assigned = await inRun(runId, (r) => r.assign(jobId, `t${wireId}`, accountId).ok);
    expect(assigned).toBe(true);
    await reset(runId);
    throw wasReset();
  };

  it.each(KINDS)(
    "by a reset before its record, %s: queued again, delivered once",
    async (...kind) => {
      const [, source, ephemeral] = kind;
      const p = await lostCall(await made(source(), ephemeral), resetBeforeRecord);
      expect(await failuresOf(p.runId)).toEqual([
        { wire_id: p.wireId, job_id: p.jobId, task: p.task, error: "" },
      ]);
      await advance(p.runId, DELIVERY_RECOVERY_MS - 1);
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      await advance(p.runId, 1);
      await expectQueued(p);
      expect(await credentialOf(p.runner)).toEqual(UNSPENT);
      expect(outcomesOf(p.wireId)).toEqual(["scheduled", "requeued"]);
      expect((await fetchTask(p.runner, 0)).task).toBeDefined();
      expect(await deliveries(p.f)).toHaveLength(source === reading ? 1 : 0);
    },
  );

  it("by a reset after a refused record, before its job was queued again: queued again", async () => {
    const p = await lostCall(await made(), async (stub, runId, ...args) => {
      await giveUp(args[0]);
      return resetBeforeRecord(stub, runId, ...args);
    });
    await later(p.runId);
    await expectQueued(p);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "requeued"]);
  });

  it("after it succeeded: everything is left alone", async () => {
    const m = await made(reading(), true);
    const p = await lostCall(m, async (stub, _runId, ...args) => {
      expect(await stub.assignTask(...args)).toHaveProperty("task");
      throw wasReset();
    });
    const tokens = await jobTokensOf(p.wireId);
    const credential = await credentialOf(p.runner);
    expect(tokens.map((t) => t.revoked_at)).toEqual([null]);
    await later(p.runId);
    await expectKept(p);
    expect(await jobTokensOf(p.wireId)).toEqual(tokens);
    expect(await credentialOf(p.runner)).toEqual(credential);
    expect(await deliveries(p.f)).toHaveLength(1);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "kept_recorded"]);
  });

  it.each(["before", "after"])(
    "while it still runs, released %s the recovery: one delivery at most, its token kept",
    async (when) => {
      const m = await made();
      const held = gate();
      await hooked(m.runId, { beforeTaskRecord: () => held.hold() });
      let slow: Promise<unknown> = Promise.resolve();
      try {
        const p = await lostCall(m, async (stub, _runId, ...args) => {
          slow = stub.assignTask(...args);
          await reached(held, slow);
          throw wasReset();
        });
        await hooked(p.runId, {});
        const finish = async () => {
          held.release();
          return slow;
        };
        if (when === "before") {
          expect(await finish()).toHaveProperty("task");
          await later(p.runId);
          await expectKept(p);
          expect((await jobTokensOf(p.wireId)).map((t) => t.revoked_at)).toEqual([null]);
        } else {
          await later(p.runId);
          await expectQueued(p);
          const task = (await fetchTask(p.runner, 0)).task;
          if (!task) throw new Error("not delivered");
          expect(await finish()).toEqual({ refused: "released" });
          await later(p.runId);
          expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
          expect((await jobTokensOf(task.id)).map((t) => t.revoked_at)).toEqual([null]);
        }
        expect(await deliveries(p.f)).toHaveLength(1);
      } finally {
        held.release();
        await Promise.allSettled([slow]);
      }
    },
  );

  it("and stored by the run too: one row, one recovery", async () => {
    const m = await made();
    await hooked(m.runId, { beforeTaskRecord: down });
    const p = await lostCall(m, async (stub, _runId, ...args) => {
      await stub.assignTask(...args);
      throw wasReset();
    });
    await hooked(p.runId, {});
    expect(await failuresOf(p.runId)).toHaveLength(1);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled"]);
    await later(p.runId);
    await expectQueued(p);
  });

  it("by an overloaded object is not reported", async () => {
    const m = await made();
    const runs = runsWith(async () => {
      throw wasReset({ overloaded: true });
    });
    await pollFails(m.runner, { overrides: runs.overrides });
    expect(runs.reports).toEqual([]);
    expect(runs.stubs()).toBe(1);
  });

  it("is told to the runner before its report is answered, which the request outlives to send", async () => {
    const m = await made();
    const held = gate();
    const runs = runsWith(resetBeforeRecord, async (stub, ...args) => {
      await held.hold();
      await stub.assignmentLost(...args);
    });
    const background = createExecutionContext();
    let over = false;
    let waiting: Promise<void> = Promise.resolve();
    try {
      await pollFails(m.runner, { overrides: runs.overrides, background });
      expect(runs.reports).toHaveLength(1);
      await held.started;
      waiting = waitOnExecutionContext(background).then(() => {
        over = true;
      });
      expect(await failuresOf(m.runId)).toEqual([]);
      expect(over).toBe(false);
    } finally {
      held.release();
      await waiting;
    }
    expect(await failuresOf(m.runId)).toHaveLength(1);
  });

  it("is told to the runner when its report fails too", async () => {
    const m = await made();
    const runs = runsWith(resetBeforeRecord, async () => {
      throw new Error("not reached");
    });
    await pollFails(m.runner, { overrides: runs.overrides });
    expect(runs.reports).toHaveLength(1);
    expect(await failuresOf(m.runId)).toEqual([]);
    expect(
      logs
        .entries()
        .filter((e) => e.msg === "failed assignment not reported" && e.runId === m.runId),
    ).toEqual([expect.objectContaining({ level: "warn", error: "not reached" })]);
  });

  it("that succeeds reports nothing and asks the run once", async () => {
    const m = await made();
    let calls = 0;
    const runs = runsWith(async (stub, _runId, ...args) => {
      calls++;
      return await stub.assignTask(...args);
    });
    expect((await fetchTask(m.runner, 0, { overrides: runs.overrides })).task).toBeDefined();
    expect([calls, runs.stubs(), runs.reports.length]).toEqual([1, 1, 0]);
    expect(await recoveryJob(m.runId)).toBeUndefined();
  });

  describe("reported", () => {
    const assignedHere = async (source = reading()) => {
      const m = await made(source);
      const { jobId } = await jobA(m.runId);
      const wireId = 900_000_000 + jobId;
      const answer = await inRun(m.runId, (r) => r.assign(jobId, `t${wireId}`, m.f.org.id));
      if (!answer.ok) throw new Error(answer.code);
      return { ...m, jobId, wireId, task: answer.task.task };
    };

    it("for another offer, another job, or an unknown one: nothing is stored", async () => {
      const p = await assignedHere();
      await runStub(p.runId).assignmentLost(p.wireId + 1, p.jobId);
      await runStub(p.runId).assignmentLost(p.wireId, p.jobId + 1);
      expect(await failuresOf(p.runId)).toEqual([]);
      expect(await recoveryJob(p.runId)).toBeUndefined();
    });

    it("before the job was assigned: nothing is stored", async () => {
      const m = await made();
      const { jobId } = await jobA(m.runId);
      await runStub(m.runId).assignmentLost(1, jobId);
      expect(await failuresOf(m.runId)).toEqual([]);
    });

    it("twice, and late: one row, at its first time", async () => {
      const p = await assignedHere();
      await runStub(p.runId).assignmentLost(p.wireId, p.jobId);
      const at = await recordedAt(p.runId);
      const due = await nextRunAt(p.runId);
      await advance(p.runId, 5 * S);
      await runStub(p.runId).assignmentLost(p.wireId, p.jobId);
      expect(await failuresOf(p.runId)).toEqual([
        { wire_id: p.wireId, job_id: p.jobId, task: p.task, error: "" },
      ]);
      expect(await recordedAt(p.runId)).toBe(at);
      expect(await nextRunAt(p.runId)).toEqual(due);
    });

    it("for a task that ended, or a run erased: nothing is stored", async () => {
      const p = await assignedHere();
      await runStub(p.runId).cancel(p.f.owner.principalId, "force");
      await runStub(p.runId).assignmentLost(p.wireId, p.jobId);
      expect(await failuresOf(p.runId)).toEqual([]);
      const q = await assignedHere();
      await runStub(q.runId).erase(q.f.repo.id);
      await runStub(q.runId).assignmentLost(q.wireId, q.jobId);
      expect(await failuresOf(q.runId)).toEqual([]);
    });

    it("about an older task of the offer: the newer one's is stored, and settled like any other", async () => {
      const p = await notRecorded();
      await giveUp(p.wireId);
      expect(await assignAgain(p)).toEqual({ refused: "released" });
      await env.DIRECTORY.prepare("UPDATE ci_tasks SET superseded_at = NULL WHERE id = ?")
        .bind(p.wireId)
        .run();
      expect(await assignAgain(p)).toHaveProperty("task");
      await runStub(p.runId).assignmentLost(p.wireId, p.jobId);
      const task = await inRun(p.runId, (r) => r.engine.instance(p.jobId)?.task);
      expect((await failuresOf(p.runId)).map((r) => r.task)).toEqual([task]);
      await later(p.runId);
      await expectKept({ ...p, task: task ?? 0 });
    });
  });
});
