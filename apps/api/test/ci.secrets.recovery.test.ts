// A delivery of a job's secrets that failed at assignment, and was not settled
// by its own attempt: its end in the directory did not commit, its answer was
// lost, or the run's object was reset before the job was failed. The run
// settles it 30 seconds later by what the directory then says of the offer,
// hands nothing out, records nothing and audits nothing. Failures are injected
// through hooks and the run's clock is the test's; a reset is an eviction.
// Every secret value made here is registered with the log capture, so a log
// line holding one fails its test.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RunDO } from "../src/do/RunDO.js";
import {
  DELIVERY_RECOVERY_MS,
  GIVE_UP_OFFERS_SQL,
  OFFERS_SQL,
  RECORD_TASK_SQL,
} from "../src/do/run/dispatch.js";
import { RUN_JOB } from "../src/do/run/engine.js";
import { putSecret, secretValue } from "./helpers/ci-secrets.js";
import {
  fetchTask,
  gate,
  jobTokensOf,
  orgRepo,
  pendingOf,
  type RegisteredRunner,
  registerRunner,
  taskRow,
  tasksOfRun,
  tasksVersionOf,
} from "./helpers/runners.js";
import {
  advance,
  at,
  checksOf,
  drain,
  expr,
  type Fixture,
  inRun,
  job,
  jobNamed,
  jobsOf,
  now,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";
import { logs } from "./setup/log-capture.js";

type OrgFixture = Fixture & { org: { id: string; login: string } };
type Hooks = RunDO["hooks"];

const S = 1_000;
const MIN = 60 * S;

const reading = (...more: string[]) =>
  workflow(job("a", ["env:", `  V: ${expr("secrets.A")}`, ...more]));

const account = (f: OrgFixture) => env.ORG.getByName(f.org.id);
const jobA = (runId: string) => jobNamed(runId, "a");

async function setSecret(f: OrgFixture, value = secretValue()) {
  expect((await putSecret(f.owner, f.path, "A", value)).status).toBeLessThan(300);
  return value;
}

/** Makes the stored secret fail to open, as a ciphertext that does not authenticate. */
async function breakSecret(f: OrgFixture) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))));
  await runInDurableObject(account(f), (_: OrgDO, state) => {
    state.storage.sql.exec("UPDATE ci_secrets SET nonce = ? WHERE name = 'A'", nonce);
  });
}

const hooked = (runId: string, hooks: Hooks) =>
  inRun(runId, (r) => {
    r.hooks = hooks;
  });

/** A reset: the next request finds a new instance, with nothing in memory. */
async function reset(runId: string) {
  await evictDurableObject(runStub(runId));
  await at(runId, now(runId));
}

type Failure = { wire_id: number; job_id: number; task: number; error: string };
const failuresOf = (runId: string) =>
  inRun(runId, (r) =>
    r.engine.rows<Failure>(
      "SELECT wire_id, job_id, task, error FROM ci_delivery_failures ORDER BY wire_id",
    ),
  );
const recoveryJob = (runId: string) => inRun(runId, (r) => r.jobs.get(RUN_JOB.delivery));

const deliveries = async (f: OrgFixture) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT details FROM audit_log WHERE target_id = ? AND action = 'ci.secrets.deliver'",
    )
      .bind(f.org.id)
      .all<{ details: string }>()
  ).results.map((r) => JSON.parse(r.details) as { task_id: number });

const reservationOf = async (runId: string) => {
  const { jobId } = await jobA(runId);
  return inRun(
    runId,
    (r) =>
      r.engine.rows<{ state: string; started_at: number | null }>(
        "SELECT state, started_at FROM ci_reservations WHERE job_id = ?",
        jobId,
      )[0],
  );
};

const minutesOf = (f: OrgFixture, runId: string) =>
  runInDurableObject(account(f), (_: OrgDO, state) =>
    state.storage.sql
      .exec<{ used: number; state: string }>(
        "SELECT used, state FROM ci_minutes WHERE key LIKE ?",
        `${runId}/%`,
      )
      .toArray(),
  );

const credentialOf = (runner: RegisteredRunner) =>
  env.DIRECTORY.prepare("SELECT expires_at, task_confirmed_at FROM ci_runners WHERE id = ?")
    .bind(runner.id)
    .first<{ expires_at: number | null; task_confirmed_at: number | null }>();

/** The outcomes logged for failed deliveries of `wireId`, in order. */
const outcomesOf = (wireId: number) =>
  logs
    .entries()
    .filter((e) => e.msg === "failed delivery" && e.taskId === wireId)
    .map((e) => e.outcome);

/** Nothing of the run's secrets left: no token was minted and no delivery audited. */
async function nothingDelivered(f: OrgFixture, runId: string) {
  for (const t of await tasksOfRun(runId)) expect(await jobTokensOf(t.id)).toEqual([]);
  expect(await deliveries(f)).toEqual([]);
}

const ERROR = "secrets_unavailable: these secrets do not open: set them again (A)";

interface Failed {
  f: OrgFixture;
  runner: RegisteredRunner;
  runId: string;
  wireId: number;
  jobId: number;
  task: number;
}

/** A run whose job's secret does not open, and a runner. */
async function undeliverable(source = reading(), ephemeral = false) {
  const f = await orgRepo();
  await setSecret(f);
  const runner = await registerRunner(f.org.login, f.owner, { ephemeral });
  const runId = await started(f, source);
  await breakSecret(f);
  return { f, runner, runId };
}

/** Its first offer's delivery failed, under `hooks`, with nothing told to the runner. */
async function failing(
  hooks: Hooks | ((runId: string) => Hooks),
  source?: string,
  ephemeral?: boolean,
): Promise<Failed> {
  const made = await undeliverable(source, ephemeral);
  await hooked(made.runId, typeof hooks === "function" ? hooks(made.runId) : hooks);
  const polled = await fetchTask(made.runner, 0).catch(() => undefined);
  expect(polled?.task).toBeUndefined();
  await hooked(made.runId, {});
  const [offer] = await tasksOfRun(made.runId);
  const { jobId } = await jobA(made.runId);
  const [row] = await failuresOf(made.runId);
  if (!offer || !row) throw new Error("the delivery did not fail unsettled");
  expect(row).toEqual({ wire_id: offer.id, job_id: jobId, task: row.task, error: ERROR });
  expect(await jobA(made.runId)).toMatchObject({ status: "in_progress" });
  return { ...made, wireId: offer.id, jobId, task: row.task };
}

const down = () => {
  throw new Error("the directory write failed");
};
/** The end in the directory did not commit. */
const notEnded = (source?: string, ephemeral?: boolean) =>
  failing({ beforeDeliveryFailure: down }, source, ephemeral);

/** What the failing attempt's end writes. */
const end = (wireId: number) =>
  env.DIRECTORY.prepare("UPDATE ci_tasks SET ended_at = 1 WHERE id = ? AND task IS NULL")
    .bind(wireId)
    .run();

/** Another call of the same offer, as a delayed or repeated one. */
const assignAgain = (p: Failed) =>
  runStub(p.runId).assignTask(p.wireId, p.jobId, p.runner.id, p.f.org.id);

/** Waits for `held` to be reached, failing at once when `request` settles first. */
async function reached(held: ReturnType<typeof gate>, request: Promise<unknown>) {
  await Promise.race([
    held.started,
    request.then(() => {
      throw new Error("the request settled before its gate");
    }),
  ]);
}

const later = (runId: string) => advance(runId, DELIVERY_RECOVERY_MS);

async function expectFailed(p: Failed) {
  const [only] = await jobsOf(p.runId);
  expect(only).toMatchObject({ status: "completed", conclusion: "failure", error: ERROR });
  expect(await failuresOf(p.runId)).toEqual([]);
  await nothingDelivered(p.f, p.runId);
}

async function expectQueued(p: Failed) {
  expect(await jobA(p.runId)).toMatchObject({ status: "queued" });
  expect(await failuresOf(p.runId)).toEqual([]);
  expect(await reservationOf(p.runId)).toEqual({ state: "reserved", started_at: null });
  expect((await taskRow(p.wireId))?.task).toBeNull();
  expect((await taskRow(p.wireId))?.superseded_at).not.toBeNull();
  await nothingDelivered(p.f, p.runId);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an offer whose end the directory did not write", () => {
  it.each(["", " and the run's object was reset"])(
    "is given up 30 s later, and its job queued again%s",
    async (how) => {
      const p = await notEnded();
      if (how !== "") await reset(p.runId);
      await advance(p.runId, DELIVERY_RECOVERY_MS - 1);
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      expect((await taskRow(p.wireId))?.superseded_at).toBeNull();
      await advance(p.runId, 1);
      await expectQueued(p);
      expect((await taskRow(p.wireId))?.ended_at).toBeNull();
      expect((await recoveryJob(p.runId))?.state).not.toBe("queued");
      expect(outcomesOf(p.wireId)).toEqual(["scheduled", "requeued"]);
      // Its next offer reads the secret again, and fails the job at once.
      expect((await fetchTask(p.runner, 0)).task).toBeUndefined();
      await drain(p.runId);
      await expectFailed(p);
      expect(await tasksOfRun(p.runId)).toHaveLength(2);
      expect(await minutesOf(p.f, p.runId)).toEqual([{ used: 0, state: "released" }]);
    },
  );

  it("delivers, once, when its secret opens again by the next offer", async () => {
    const p = await notEnded();
    await later(p.runId);
    await expectQueued(p);
    const value = await setSecret(p.f);
    const task = (await fetchTask(p.runner, 0)).task;
    expect(task?.secrets.get("A")).toBe(value);
    expect(await deliveries(p.f)).toEqual([expect.objectContaining({ task_id: task?.id })]);
    await later(p.runId);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    expect(await failuresOf(p.runId)).toEqual([]);
  });

  it("is told to every runner of its account: the version is bumped", async () => {
    const p = await notEnded();
    await drain(p.runId);
    const before = await tasksVersionOf(p.f.org.id);
    expect(await pendingOf(p.runId)).toEqual([]);
    await later(p.runId);
    expect(await tasksVersionOf(p.f.org.id)).toBeGreaterThan(before);
    expect((await pendingOf(p.runId)).map((r) => [r.job_id, r.claimed_by])).toEqual([
      [p.jobId, null],
    ]);
  });

  it("leaves an ephemeral runner's credential unspent", async () => {
    const p = await notEnded(reading(), true);
    await later(p.runId);
    expect(await credentialOf(p.runner)).toEqual({ expires_at: null, task_confirmed_at: null });
  });

  it("waits out the claim of a pending row another poll renewed", async () => {
    const p = await notEnded();
    // The pass that withdraws the row has not run, and the claim on it stands.
    await inRun(p.runId, (r) =>
      r.engine.exec(
        "UPDATE jobs SET next_run_at = next_run_at + ? WHERE job_id = ?",
        60 * MIN,
        RUN_JOB.dispatch,
      ),
    );
    const [held] = await pendingOf(p.runId);
    expect(held?.claimed_by).toBe(p.runner.id);
    await later(p.runId);
    await expectQueued(p);
    expect((await pendingOf(p.runId)).map((r) => [r.id, r.claimed_by])).toEqual([
      [held?.id, p.runner.id],
    ]);
    const value = await setSecret(p.f);
    const other = await registerRunner(p.f.org.login, p.f.owner);
    expect((await fetchTask(other, 0)).task).toBeUndefined();
    vi.setSystemTime(Date.now() + 31 * S);
    expect((await fetchTask(other, 0)).task?.secrets.get("A")).toBe(value);
  });
});

describe("an offer the directory ended", () => {
  it("whose answer was lost fails its job 30 s later, with the delivery's error", async () => {
    const p = await failing((runId) => ({
      beforeDeliveryFailure: async () => {
        await env.DIRECTORY.prepare(
          "UPDATE ci_tasks SET ended_at = 1 WHERE run_id = ? AND task IS NULL",
        )
          .bind(runId)
          .run();
        throw new Error("the answer was lost");
      },
    }));
    await advance(p.runId, DELIVERY_RECOVERY_MS - 1);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    await advance(p.runId, 1);
    await expectFailed(p);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "failed_ended"]);
    expect(await taskRow(p.wireId)).toMatchObject({ task: null, superseded_at: null });
  });

  it("before a reset that kept its job from being failed: the same, with one failed check", async () => {
    const p = await failing(
      {
        afterDeliveryFailure: () => {
          throw new Error("the run object was reset");
        },
      },
      reading(),
      true,
    );
    await reset(p.runId);
    await later(p.runId);
    await advance(p.runId, MIN);
    await expectFailed(p);
    expect((await checksOf(p.f)).get("a")).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
    expect(await credentialOf(p.runner)).toEqual({ expires_at: null, task_confirmed_at: null });
    expect(await reservationOf(p.runId)).toMatchObject({ state: "settled", started_at: null });
    expect(await minutesOf(p.f, p.runId)).toEqual([{ used: 0, state: "released" }]);
    expect(await pendingOf(p.runId)).toEqual([]);
    expect((await fetchTask(p.runner, 0)).task).toBeUndefined();
  });
});

describe("a failed delivery its own attempt settles", () => {
  it("is on disk before the directory is asked, and forgotten with the job's failure", async () => {
    const { f, runner, runId } = await undeliverable();
    const order: string[] = [];
    await inRun(runId, (r) => {
      const storage = (r as unknown as { ctx: DurableObjectState }).ctx.storage;
      const sync = storage.sync.bind(storage);
      vi.spyOn(storage, "sync").mockImplementation(async () => {
        await sync();
        order.push("durable");
      });
      r.hooks = {
        beforeDeliveryFailure: () => {
          const rows = r.engine.rows<Failure>("SELECT error FROM ci_delivery_failures");
          order.push(`asked:${rows.map((x) => x.error).join()}`);
          order.push(`job:${r.jobs.get(RUN_JOB.delivery)?.state}`);
        },
      };
    });
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(order).toEqual(["durable", `asked:${ERROR}`, "job:queued"]);
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure", error: ERROR });
    expect(await failuresOf(runId)).toEqual([]);
    let asked = 0;
    await hooked(runId, { beforeDeliveryRecovery: () => void asked++ });
    await later(runId);
    expect(asked).toBe(0);
    expect((await recoveryJob(runId))?.state).toBe("done");
    await nothingDelivered(f, runId);
  });

  it("when its offer is made again and fails again", async () => {
    const p = await notEnded();
    await advance(p.runId, 20 * S);
    expect(await assignAgain(p)).toEqual({ refused: "task_finished" });
    await expectFailed(p);
    const ended = (await taskRow(p.wireId))?.ended_at;
    await later(p.runId);
    await expectFailed(p);
    expect(await taskRow(p.wireId)).toMatchObject({ ended_at: ended, superseded_at: null });
  });

  it("when its offer is made again and delivers: the job is kept", async () => {
    const p = await notEnded();
    await setSecret(p.f);
    expect(await assignAgain(p)).toHaveProperty("task");
    expect(await deliveries(p.f)).toHaveLength(1);
    await later(p.runId);
    expect(await failuresOf(p.runId)).toEqual([]);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    expect(await taskRow(p.wireId)).toMatchObject({
      task: p.task,
      ended_at: null,
      superseded_at: null,
    });
    expect(await deliveries(p.f)).toHaveLength(1);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "kept_recorded"]);
  });

  it("when a failing re-offer finds the task recorded: the job is kept and nothing is left", async () => {
    const p = await notEnded();
    await env.DIRECTORY.prepare(RECORD_TASK_SQL).bind(p.task, p.wireId).run();
    expect(await assignAgain(p)).toEqual({ refused: "secrets_undeliverable" });
    expect(await failuresOf(p.runId)).toEqual([]);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
  });

  it("is looked at 30 s after its last failing attempt", async () => {
    const p = await notEnded();
    await advance(p.runId, 20 * S);
    await hooked(p.runId, { beforeDeliveryFailure: down });
    expect(await assignAgain(p)).toEqual({ refused: "secrets_undeliverable" });
    await hooked(p.runId, {});
    await advance(p.runId, DELIVERY_RECOVERY_MS - 1);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    await advance(p.runId, 1);
    await expectQueued(p);
  });
});

describe("a record against a recovery", () => {
  it("that lands after the offer was given up records nothing, audits nothing, and mints nothing", async () => {
    const p = await notEnded();
    await setSecret(p.f);
    const held = gate();
    await hooked(p.runId, { beforeTaskRecord: () => held.hold() });
    const slow = assignAgain(p);
    try {
      await reached(held, slow);
      await later(p.runId);
      await expectQueued(p);
      const rev = await inRun(p.runId, (r) => r.engine.run()?.queue_rev);
      held.release();
      expect(await slow).toEqual({ refused: "released" });
      await expectQueued(p);
      expect(await inRun(p.runId, (r) => r.engine.run()?.queue_rev)).toBe(rev);
    } finally {
      held.release();
      await Promise.allSettled([slow]);
    }
  });

  it.each(["", " and is superseded after", " and has a token minted"])(
    "that lands first%s keeps the job",
    async (how) => {
      const p = await notEnded();
      await hooked(p.runId, {
        beforeDeliveryRecovery: async () => {
          if (how === " and has a token minted")
            await env.DIRECTORY.prepare(
              "INSERT INTO ci_job_tokens (token_id, task_id, created_at) VALUES (?, ?, 1)",
            )
              .bind(crypto.randomUUID(), p.wireId)
              .run();
          else await env.DIRECTORY.prepare(RECORD_TASK_SQL).bind(p.task, p.wireId).run();
          if (how === " and is superseded after")
            await env.DIRECTORY.prepare("UPDATE ci_tasks SET superseded_at = 5 WHERE id = ?")
              .bind(p.wireId)
              .run();
        },
      });
      const before = await taskRow(p.wireId);
      await later(p.runId);
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      expect(await failuresOf(p.runId)).toEqual([]);
      expect(await reservationOf(p.runId)).toMatchObject({ state: "running" });
      const after = await taskRow(p.wireId);
      expect(after?.ended_at).toBeNull();
      if (how !== " and is superseded after") expect(after?.superseded_at).toBeNull();
      expect(before?.superseded_at).toBeNull();
      expect(outcomesOf(p.wireId)).toEqual(["scheduled", "kept_recorded"]);
    },
  );
});

describe("a failing attempt that outlives its recovery", () => {
  /** An attempt held before its end is written, its job queued again by the recovery meanwhile. */
  async function outlived(fn: (p: Failed, finish: () => Promise<unknown>) => Promise<void>) {
    const p = await notEnded();
    const held = gate();
    let calls = 0;
    await hooked(p.runId, {
      beforeDeliveryFailure: () => (++calls === 1 ? held.hold() : undefined),
    });
    const slow = assignAgain(p);
    try {
      await reached(held, slow);
      await later(p.runId);
      await expectQueued(p);
      await fn(p, async () => {
        held.release();
        expect(await slow).toEqual({ refused: "task_finished" });
      });
    } finally {
      held.release();
      await Promise.allSettled([slow]);
      await hooked(p.runId, {});
    }
  }

  it("ends the offer late and leaves the job queued", () =>
    outlived(async (p, finish) => {
      await finish();
      expect((await taskRow(p.wireId))?.ended_at).not.toBeNull();
      await expectQueued(p);
      await later(p.runId);
      await expectQueued(p);
    }));

  it("leaves the task the job was given meanwhile running", () =>
    outlived(async (p, finish) => {
      const value = await setSecret(p.f);
      const other = await registerRunner(p.f.org.login, p.f.owner);
      const task = (await fetchTask(other, 0)).task;
      expect(task?.secrets.get("A")).toBe(value);
      await finish();
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      await later(p.runId);
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      expect(await deliveries(p.f)).toHaveLength(1);
    }));

  it("and a delayed call of the same offer, about to record a new task: that task is queued again", () =>
    outlived(async (p, finish) => {
      await setSecret(p.f);
      const record = gate();
      await hooked(p.runId, { beforeTaskRecord: () => record.hold() });
      const delayed = assignAgain(p);
      try {
        await reached(record, delayed);
        expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
        await finish();
        expect(await taskRow(p.wireId)).toMatchObject({
          task: null,
          ended_at: expect.any(Number),
          superseded_at: expect.any(Number),
        });
        record.release();
        expect(await delayed).toEqual({ refused: "released" });
      } finally {
        record.release();
        await delayed;
      }
      await expectQueued(p);
    }));

  it("and a delayed call of the same offer whose delivery fails too: its own failure is kept, and settled", () =>
    outlived(async (p, finish) => {
      await hooked(p.runId, { beforeDeliveryFailure: down });
      expect(await assignAgain(p)).toEqual({ refused: "secrets_undeliverable" });
      const [second] = await failuresOf(p.runId);
      expect(second?.wire_id).toBe(p.wireId);
      expect(second?.task).not.toBe(p.task);
      await hooked(p.runId, {});
      await finish();
      expect(await failuresOf(p.runId)).toEqual([second]);
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      await later(p.runId);
      await expectFailed(p);
    }));

  it("finds its job failed by the recovery, when its end committed first", async () => {
    const made = await undeliverable();
    const held = gate();
    await hooked(made.runId, { afterDeliveryFailure: () => held.hold() });
    const first = fetchTask(made.runner, 0);
    try {
      await reached(held, first);
      const [row] = await failuresOf(made.runId);
      if (!row) throw new Error("no failed delivery");
      const p: Failed = { ...made, wireId: row.wire_id, jobId: row.job_id, task: row.task };
      await later(p.runId);
      await expectFailed(p);
      const ended = await inRun(p.runId, (r) => r.engine.run()?.task_end_seq);
      held.release();
      expect((await first).task).toBeUndefined();
      await expectFailed(p);
      expect(await inRun(p.runId, (r) => r.engine.run()?.task_end_seq)).toBe(ended);
    } finally {
      held.release();
      await Promise.allSettled([first]);
    }
  });
});

describe("a call of an offer given up by the recovery", () => {
  it("that would deliver queues its job again, recording nothing", async () => {
    const p = await notEnded();
    await later(p.runId);
    await setSecret(p.f);
    expect(await assignAgain(p)).toEqual({ refused: "released" });
    await expectQueued(p);
  });

  it("whose delivery fails ends it and fails the job", async () => {
    const p = await notEnded();
    await later(p.runId);
    expect(await assignAgain(p)).toEqual({ refused: "task_finished" });
    await drain(p.runId);
    await expectFailed(p);
  });
});

describe("a recovery that is cut or overlapped", () => {
  it.each(["requeued", "failed"] as const)(
    "after the directory answered, comes to the same outcome: %s",
    async (outcome) => {
      const p = await notEnded();
      if (outcome === "failed") await end(p.wireId);
      let cuts = 0;
      await hooked(p.runId, {
        afterDeliveryRecovery: () => {
          if (++cuts === 1) throw new Error("the recovery was cut");
        },
      });
      await later(p.runId);
      expect(cuts).toBe(1);
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      const written = await taskRow(p.wireId);
      await advance(p.runId, 2 * S);
      expect(cuts).toBe(2);
      expect(await taskRow(p.wireId)).toEqual(written);
      if (outcome === "failed") await expectFailed(p);
      else await expectQueued(p);
    },
  );

  it("by a reset while it backs off goes on", async () => {
    const p = await notEnded();
    await hooked(p.runId, { beforeDeliveryRecovery: down });
    await later(p.runId);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    await reset(p.runId);
    await advance(p.runId, 2 * S);
    await expectQueued(p);
  });

  it("outliving its lease writes nothing once taken over", async () => {
    const p = await notEnded();
    const held = gate();
    let calls = 0;
    await hooked(p.runId, {
      afterDeliveryRecovery: () => (++calls === 1 ? held.hold() : undefined),
    });
    await at(p.runId, now(p.runId) + DELIVERY_RECOVERY_MS);
    const first = inRun(p.runId, (r) => r.alarm());
    try {
      await reached(held, first);
      await advance(p.runId, 2 * MIN);
      expect(calls).toBe(2);
      await expectQueued(p);
      // Given to a runner meanwhile: the slice taken over must not touch its task.
      await setSecret(p.f);
      expect((await fetchTask(p.runner, 0)).task).toBeDefined();
      held.release();
      await first;
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      expect(await reservationOf(p.runId)).toMatchObject({ state: "running" });
    } finally {
      held.release();
      await Promise.allSettled([first]);
    }
  });

  it("outliving its lease settles nothing, though its successor has settled nothing yet", async () => {
    const p = await notEnded();
    const held = gate();
    let calls = 0;
    await hooked(p.runId, {
      beforeDeliveryRecovery: () => {
        if (++calls === 2) down();
      },
      afterDeliveryRecovery: () => (calls === 1 ? held.hold() : undefined),
    });
    await at(p.runId, now(p.runId) + DELIVERY_RECOVERY_MS);
    const first = inRun(p.runId, (r) => r.alarm());
    try {
      await reached(held, first);
      await advance(p.runId, 2 * MIN);
      expect(calls).toBe(2);
      held.release();
      await first;
      expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
      expect(await failuresOf(p.runId)).toHaveLength(1);
      await advance(p.runId, 2 * S);
      expect(calls).toBe(3);
      await expectQueued(p);
    } finally {
      held.release();
      await Promise.allSettled([first]);
    }
  });

  it("by its own attempt settling first changes nothing", async () => {
    const p = await notEnded();
    const held = gate();
    await hooked(p.runId, { beforeDeliveryRecovery: () => held.hold() });
    await at(p.runId, now(p.runId) + DELIVERY_RECOVERY_MS);
    const recovery = inRun(p.runId, (r) => r.alarm());
    try {
      await reached(held, recovery);
      expect(await assignAgain(p)).toEqual({ refused: "task_finished" });
      await expectFailed(p);
      held.release();
      await recovery;
      await drain(p.runId);
      await expectFailed(p);
      expect(await taskRow(p.wireId)).toMatchObject({ superseded_at: null });
      expect(outcomesOf(p.wireId)).toEqual(["scheduled", "scheduled"]);
    } finally {
      held.release();
      await Promise.allSettled([recovery]);
    }
  });
});

describe("a directory that does not answer a recovery", () => {
  it("is asked again with back-off until it does", async () => {
    const p = await notEnded();
    let calls = 0;
    await hooked(p.runId, {
      beforeDeliveryRecovery: () => {
        if (++calls <= 3) down();
      },
    });
    await later(p.runId);
    for (const wait of [1, 2, 4]) await advance(p.runId, wait * S);
    expect(calls).toBe(4);
    await expectQueued(p);
    expect((await runStub(p.runId).get())?.faults).toEqual([]);
  });

  it("for too long leaves the job to its heartbeat deadline, and no fault or row once it answers", async () => {
    const p = await notEnded();
    await hooked(p.runId, { beforeDeliveryRecovery: down });
    await later(p.runId);
    // Ten attempts, waits doubling from a second: all before the deadline.
    for (let wait = 1; wait <= 256; wait *= 2) await advance(p.runId, wait * S);
    expect((await runStub(p.runId).get())?.faults).toEqual([
      expect.objectContaining({ kind: "ci_delivery", count: 1 }),
    ]);
    expect(await jobA(p.runId)).toMatchObject({ status: "in_progress" });
    await advance(p.runId, 2 * MIN);
    const [only] = await jobsOf(p.runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error ?? "").not.toContain("secrets_unavailable");
    expect(await failuresOf(p.runId)).toHaveLength(1);
    let asked = 0;
    await hooked(p.runId, { beforeDeliveryRecovery: () => void asked++ });
    await advance(p.runId, 30 * MIN);
    expect(asked).toBe(0);
    expect(await failuresOf(p.runId)).toEqual([]);
    expect((await runStub(p.runId).get())?.faults).toEqual([]);
    expect(outcomesOf(p.wireId)).toEqual(["scheduled", "discarded_not_live"]);
  });
});

describe("a recovery that was lost", () => {
  it("is scheduled again by the run's sweep", async () => {
    const p = await notEnded();
    // Past the checks' flush window, so nothing else is owed first.
    await advance(p.runId, 5 * S);
    await inRun(p.runId, (r) => {
      r.engine.exec("DELETE FROM jobs WHERE job_id = ?", RUN_JOB.delivery);
      r.jobs.ensure("run_sweep", RUN_JOB.sweep);
    });
    await drain(p.runId);
    expect((await recoveryJob(p.runId))?.state).toBe("queued");
    await later(p.runId);
    await expectQueued(p);
  });
});

describe("a job ended another way meanwhile", () => {
  it.each(["force", "graceful"] as const)(
    "cancelled (%s): the recovery gives nothing back to the queue",
    async (mode) => {
      const p = await notEnded();
      let asked = 0;
      await hooked(p.runId, { beforeDeliveryRecovery: () => void asked++ });
      await runStub(p.runId).cancel(p.f.owner.principalId, mode);
      await later(p.runId);
      expect(await failuresOf(p.runId)).toEqual([]);
      expect(asked).toBe(mode === "force" ? 0 : 1);
      await advance(p.runId, 3 * MIN);
      expect(await jobA(p.runId)).toMatchObject({ status: "completed", conclusion: "cancelled" });
      expect(await pendingOf(p.runId)).toEqual([]);
      await nothingDelivered(p.f, p.runId);
    },
  );

  it("cancelled gracefully, its offer ended: completes at the recovery", async () => {
    const p = await notEnded();
    await end(p.wireId);
    await runStub(p.runId).cancel(p.f.owner.principalId, "graceful");
    await later(p.runId);
    expect(await jobA(p.runId)).toMatchObject({ status: "completed" });
    expect(await failuresOf(p.runId)).toEqual([]);
    expect(await reservationOf(p.runId)).toMatchObject({ state: "settled", started_at: null });
  });

  it("force-cancelled before the failure was recorded: none is", async () => {
    const f = await orgRepo();
    await setSecret(f, secretValue(40 * 1024));
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = await started(f, reading());
    await hooked(runId, {
      beforeSecretMasks: async () => {
        await runStub(runId).cancel(f.owner.principalId, "force");
      },
    });
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await failuresOf(runId)).toEqual([]);
    expect(await recoveryJob(runId)).toBeUndefined();
    await drain(runId);
    expect(await jobA(runId)).toMatchObject({ status: "completed", conclusion: "cancelled" });
  });

  it("past its one-minute timeout while the directory does not answer", async () => {
    const p = await notEnded(reading().replace("    steps:", "    timeout-minutes: 1\n    steps:"));
    await hooked(p.runId, { beforeDeliveryRecovery: down });
    await later(p.runId);
    await advance(p.runId, MIN);
    await hooked(p.runId, {});
    for (let i = 0; i < 5; i++) await advance(p.runId, MIN);
    expect(await jobA(p.runId)).toMatchObject({ status: "completed" });
    expect(await failuresOf(p.runId)).toEqual([]);
    expect(await pendingOf(p.runId)).toEqual([]);
    await nothingDelivered(p.f, p.runId);
  });
});

describe("a run erased or retiring", () => {
  const left = (runId: string) =>
    inRun(runId, (r) => ({
      rows: r.engine.rows("SELECT 1 FROM ci_delivery_failures").length,
      jobs: r.engine.rows<{ kind: string }>("SELECT kind FROM jobs").map((j) => j.kind),
      instances: r.engine.rows("SELECT 1 FROM run_instances").length,
    }));

  it("with a failed delivery to settle keeps no row and no job but its purge", async () => {
    const p = await notEnded();
    await inRun(p.runId, (r) => r.erase(p.f.repo.id));
    expect(await left(p.runId)).toEqual({ rows: 0, jobs: ["run_log_purge"], instances: 0 });
    await later(p.runId);
    expect((await left(p.runId)).rows).toBe(0);
    expect((await taskRow(p.wireId))?.superseded_at).toBeNull();
  });

  it("while a recovery awaits the directory is not brought back", async () => {
    const p = await notEnded();
    await hooked(p.runId, {
      afterDeliveryRecovery: () => inRunErase(p),
    });
    await later(p.runId);
    expect(await left(p.runId)).toMatchObject({ rows: 0, instances: 0 });
    expect((await left(p.runId)).jobs).not.toContain("ci_delivery");
  });

  it("while a delivery failed, before it was recorded, records nothing", async () => {
    const { f, runner, runId } = await undeliverable();
    await setSecret(f, secretValue(40 * 1024));
    await hooked(runId, {
      beforeSecretMasks: () => inRunErase({ runId, f }),
    });
    await fetchTask(runner, 0).catch(() => undefined);
    expect(await left(runId)).toEqual({ rows: 0, jobs: ["run_log_purge"], instances: 0 });
  });

  it("after a failure was recorded, before its job was failed, fails nothing", async () => {
    const { f, runner, runId } = await undeliverable();
    await hooked(runId, { afterDeliveryFailure: () => inRunErase({ runId, f }) });
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await left(runId)).toEqual({ rows: 0, jobs: ["run_log_purge"], instances: 0 });
  });

  it("acts on no failed delivery once it retires", async () => {
    const p = await notEnded();
    let asked = 0;
    await hooked(p.runId, { beforeDeliveryRecovery: () => void asked++ });
    await inRun(p.runId, (r) =>
      r.jobs.ensure("run_retire", RUN_JOB.retire, { runAt: now(p.runId) + 60 * MIN }),
    );
    await later(p.runId);
    expect(asked).toBe(0);
    expect(await inRun(p.runId, (r) => r.engine.instance(p.jobId)?.status)).toBe("in_progress");
    expect((await taskRow(p.wireId))?.superseded_at).toBeNull();
  });

  const inRunErase = async (p: { runId: string; f: OrgFixture }) => {
    await runStub(p.runId).erase(p.f.repo.id);
  };
});

describe("deliveries with nothing to recover", () => {
  it.each([
    // The record, its earlier tokens, where the offer stands, and the audit row of a delivery.
    ["that succeeds", reading(), 4],
    ["of a job with no secret", workflow(job("a")), 3],
  ])("a delivery %s writes no row and schedules nothing", async (_, source, statements) => {
    const f = await orgRepo();
    await setSecret(f);
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = await started(f, source);
    let synced = 0;
    const queries: [string, number | undefined][] = [];
    await inRun(runId, (r) => {
      const storage = (r as unknown as { ctx: DurableObjectState }).ctx.storage;
      vi.spyOn(storage, "sync").mockImplementation(async () => void synced++);
      vi.spyOn(r.context.metrics, "count").mockImplementation((name, dims, n) => {
        if (name === "d1.query") queries.push([String(dims?.op), n]);
      });
    });
    expect((await fetchTask(runner, 0)).task).toBeDefined();
    expect(synced).toBe(0);
    expect(queries.filter(([op]) => op === "ci_task_assigned")).toEqual([
      ["ci_task_assigned", statements],
    ]);
    expect(queries.filter(([op]) => /undeliverable|delivery/.test(op))).toEqual([]);
    expect(await failuresOf(runId)).toEqual([]);
    expect(await recoveryJob(runId)).toBeUndefined();
  });
});

describe("every failed delivery is recovered", () => {
  it.each([
    ["secrets_unmaskable", (f: OrgFixture) => setSecret(f, secretValue(40 * 1024))],
    [
      // Past 512 KiB of value text together, so not read from the account at all.
      "secrets_unmaskable: these secrets are more than a job is given",
      async (f: OrgFixture) => {
        for (let i = 0; i < 11; i++)
          expect(
            (await putSecret(f.owner, f.path, `S${i}`, secretValue(48 * 1024))).status,
          ).toBeLessThan(300);
      },
    ],
    [
      "owner_changed",
      (_: OrgFixture, runId: string) =>
        inRun(runId, (r) => r.engine.exec("UPDATE runs SET owner_id = 'another'")),
    ],
  ] as const)("%s", async (error, spoil) => {
    const f = await orgRepo();
    await setSecret(f);
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = await started(f, workflow(job("a", ["env:", `  V: ${expr("toJSON(secrets)")}`])));
    await spoil(f, runId);
    let interrupted = 0;
    await hooked(runId, {
      afterDeliveryFailure: () => {
        interrupted++;
        throw new Error("the run object was reset");
      },
    });
    await fetchTask(runner, 0).catch(() => undefined);
    expect(interrupted).toBe(1);
    expect(await jobA(runId)).toMatchObject({ status: "in_progress" });
    expect((await failuresOf(runId)).map((r) => r.error)).toEqual([
      expect.stringMatching(new RegExp(`^${error}`)),
    ]);
    await reset(runId);
    await later(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(new RegExp(`^${error}`));
    await nothingDelivered(f, runId);
  });
});

describe("the work of a recovery", () => {
  it("drops rows of ended tasks without asking the directory, a page at a time", async () => {
    const p = await notEnded();
    await runStub(p.runId).cancel(p.f.owner.principalId, "force");
    await drain(p.runId);
    let asked = 0;
    await inRun(p.runId, (r) => {
      for (let i = 0; i < 149; i++)
        r.engine.exec(
          "INSERT INTO ci_delivery_failures VALUES (?, ?, ?, 'secrets_unavailable: x', ?)",
          1_000_000 + i,
          p.jobId,
          500 + i,
          now(p.runId),
        );
      r.hooks = { beforeDeliveryRecovery: () => void asked++ };
    });
    await later(p.runId);
    expect(await failuresOf(p.runId)).toEqual([]);
    expect(asked).toBe(0);
  });

  it("settles a full page of live jobs in one directory call, and the rest in another", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const numbers = Array.from({ length: 101 }, (_, i) => i);
    const runId = await started(
      f,
      workflow(
        job("a", ["strategy:", "  fail-fast: false", `  matrix: { n: [${numbers.join(", ")}] }`]),
      ),
    );
    const instances = () =>
      inRun(runId, (r) =>
        r.engine.rows<{ job_id: number; status: string; error: string | null }>(
          "SELECT job_id, status, error FROM run_instances ORDER BY job_id",
        ),
      );
    const jobs = await instances();
    expect(jobs.map((j) => j.status)).toEqual(numbers.map(() => "queued"));
    const { results: offers } = await env.DIRECTORY.prepare(
      `INSERT INTO ci_tasks (run_id, job_id, runner_id, offered_version, created_at, repo_id, fork)
       SELECT ?1, value, ?2, 0, ?3, ?4, 0 FROM json_each(?5) RETURNING id, job_id`,
    )
      .bind(runId, runner.id, Date.now(), f.repo.id, JSON.stringify(jobs.map((j) => j.job_id)))
      .all<{ id: number; job_id: number }>();
    // The oldest failure's offer ended; every other one neither ended nor was recorded.
    const ended = offers[0] as { id: number; job_id: number };
    await end(ended.id);
    const pages: number[] = [];
    await inRun(runId, (r) => {
      offers.forEach((offer) => {
        const assigned = r.assign(offer.job_id, `t${offer.id}`);
        if (!assigned.ok) throw new Error(assigned.code);
        r.engine.exec(
          "INSERT INTO ci_delivery_failures VALUES (?, ?, ?, 'secrets_unavailable: x', ?)",
          offer.id,
          offer.job_id,
          assigned.task.task,
          now(runId),
        );
      });
      r.jobs.ensure("ci_delivery", RUN_JOB.delivery, { runAt: now(runId) + DELIVERY_RECOVERY_MS });
      const waiting = () => r.engine.rows("SELECT 1 FROM ci_delivery_failures").length;
      r.hooks = { beforeDeliveryRecovery: () => void pages.push(waiting()) };
    });
    await later(runId);
    expect(pages).toEqual([101, 1]);
    expect(await failuresOf(runId)).toEqual([]);
    const after = await instances();
    expect(after.filter((j) => j.status === "completed").map((j) => [j.job_id, j.error])).toEqual([
      [ended.job_id, "secrets_unavailable: x"],
    ]);
    expect(after.filter((j) => j.status === "queued")).toHaveLength(100);
  });

  it("looks its offers up by key, scanning neither offers nor tokens", async () => {
    for (const [sql, ...binds] of [
      [GIVE_UP_OFFERS_SQL, 1, "[1,2]"],
      [OFFERS_SQL, "[1,2]"],
    ] as const) {
      const { results } = await env.DIRECTORY.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>();
      const details = results.map((r) => r.detail);
      expect(
        details.filter((d) => /^SCAN (ci_tasks|ci_job_tokens|j)\b/.test(d)),
        details.join("\n"),
      ).toEqual([]);
    }
  });
});
