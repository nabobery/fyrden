// Each test sets the run, the account's object and D1's ledger clock to the
// same instant, and runs the alarms it needs itself.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { applyDoMigrations } from "@fyrden/adapters-cloudflare/migrations";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CI_JOB_FIXED, CI_NOW, ciVariableOverrides } from "../src/ci/budget.js";
import { startRun } from "../src/ci/runs.js";
import type { AssignAnswer } from "../src/do/RunDO.js";
import type { CiCall } from "../src/do/run/reservations.js";
import type { RunSpec } from "../src/do/run/spec.js";
import { runSchema } from "../src/do/schema/run.js";
import { api, json } from "./helpers/api.js";
import { pinD1Clock } from "./helpers/d1.js";
import {
  fetchTask,
  newOrg,
  orgRepo,
  pendingOf,
  registerRunner,
  tasksOfRun,
} from "./helpers/runners.js";
import {
  at,
  drain,
  type Fixture,
  inRun,
  job,
  jobNamed,
  jobsOf,
  repoWithCommit,
  runStub,
  specFor,
  workflow,
} from "./helpers/runs.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const one = workflow(job("a"));
const two = workflow([job("a"), job("b")].join("\n"));

const ledgerClock = { now: 0 };
let unpin: () => void;
beforeAll(() => {
  unpin = pinD1Clock(CI_NOW, ledgerClock);
});
afterAll(() => unpin());

beforeEach(() => {
  ciVariableOverrides.FYRDEN_PLAN = "free";
});

let days = 0;
/** Noon of a UTC day no other test of this file charges: the ledger's days are the deployment's. */
function freshNoon(): number {
  days += 3;
  return Date.UTC(2031, 5, 1) + days * DAY + 12 * HOUR;
}

/** Sets every clock to a fresh noon, so user tokens made afterwards are valid at this test's times. */
async function today(): Promise<number> {
  const t = freshNoon();
  await moveTo(t);
  return t;
}

async function moveTo(t: number, runId?: string): Promise<void> {
  vi.setSystemTime(t);
  ledgerClock.now = t;
  if (runId) await at(runId, t);
}

async function startedAt(
  f: Fixture,
  source: string,
  t: number,
  extra: Partial<RunSpec> = {},
): Promise<string> {
  const spec = specFor(f, source, extra);
  await moveTo(t, spec.runId);
  expect((await startRun(env, spec)).ok).toBe(true);
  await at(spec.runId, t);
  await drain(spec.runId);
  return spec.runId;
}

type Reservation = {
  job_id: number;
  seq: number;
  state: string;
  key: string | null;
  account_id: string | null;
  minutes: number | null;
  retry_at: number | null;
  refusals: number;
  waiting_for: string | null;
  ineligible_at: number | null;
  started_at: number | null;
  asked_for: string | null;
};

const reservationOf = async (runId: string, name: string): Promise<Reservation> => {
  const { jobId } = await jobNamed(runId, name);
  const [row] = await inRun(runId, (r) =>
    r.engine.rows<Reservation>("SELECT * FROM ci_reservations WHERE job_id = ?", jobId),
  );
  if (!row) throw new Error(`no reservation for ${name}`);
  return row;
};

const receiptsOf = async (runId: string) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT key, kind, state, minutes FROM ci_budget_receipts WHERE key LIKE ? ORDER BY key",
    )
      .bind(`${runId}/%`)
      .all<{ key: string; kind: string | null; state: string; minutes: number | null }>()
  ).results;

const dayOf = async (t: number) =>
  env.DIRECTORY.prepare("SELECT * FROM ci_budget_days WHERE day = ?")
    .bind(Math.floor(t / DAY))
    .first<Record<string, number>>();

const minutesOf = (accountId: string, runId: string) =>
  runInDurableObject(env.ORG.getByName(accountId), (_, state) =>
    state.storage.sql
      .exec<{ key: string; reserved: number; used: number; state: string }>(
        "SELECT key, reserved, used, state FROM ci_minutes WHERE key LIKE ? ORDER BY key",
        `${runId}/%`,
      )
      .toArray(),
  );

async function recordCalls(runId: string): Promise<{ op: CiCall; key: string }[]> {
  const calls: { op: CiCall; key: string }[] = [];
  await inRun(runId, (r) => {
    r.hooks = {
      ...r.hooks,
      beforeCiCall: (op, key) => {
        calls.push({ op, key });
      },
    };
  });
  return calls;
}

const payloadTimeout = (payload: Uint8Array) =>
  (
    JSON.parse(new TextDecoder().decode(payload)) as {
      jobs: Record<string, Record<string, unknown>>;
    }
  ).jobs.a?.["timeout-minutes"];

const assign = async (runId: string, name: string, key: string, accountId: string) =>
  (await runStub(runId).assign(
    (
      await jobNamed(runId, name)
    ).jobId,
    key,
    accountId,
  )) as AssignAnswer;

describe("publishing", () => {
  it("publishes a job only once its minutes are reserved", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const spec = specFor(f, one);
    await moveTo(t, spec.runId);
    expect((await startRun(env, spec)).ok).toBe(true);
    await inRun(spec.runId, (r) => {
      r.hooks = {
        beforeCiCall: () => {
          throw new Error("the ledger is unreachable");
        },
      };
    });
    await drain(spec.runId);
    expect((await jobNamed(spec.runId, "a")).status).toBe("queued");
    expect(await pendingOf(spec.runId)).toEqual([]);
    expect(await reservationOf(spec.runId, "a")).toMatchObject({ seq: 1, state: "wanted" });
    expect(await assign(spec.runId, "a", "k", f.owner.principalId)).toEqual({
      ok: false,
      code: "not_queued",
    });

    await inRun(spec.runId, (r) => {
      r.hooks = {};
    });
    await moveTo(t + MIN, spec.runId);
    await drain(spec.runId);
    const { jobId } = await jobNamed(spec.runId, "a");
    expect(await reservationOf(spec.runId, "a")).toMatchObject({
      seq: 1,
      state: "reserved",
      key: `${spec.runId}/j${jobId}/r1`,
      account_id: f.owner.principalId,
      waiting_for: null,
    });
    expect(await pendingOf(spec.runId)).toEqual([
      expect.objectContaining({ job_id: jobId, account_id: f.owner.principalId }),
    ]);
    expect(await receiptsOf(spec.runId)).toEqual([
      { key: `${spec.runId}/j${jobId}/r1`, kind: "job", state: "granted", minutes: 180 },
    ]);
    expect(await minutesOf(f.owner.principalId, spec.runId)).toEqual([
      { key: `${spec.runId}/j${jobId}/r1`, reserved: 180, used: 0, state: "held" },
    ]);
  });

  it("assigns only a reserved job, inside its window, for the account it was reserved for", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    expect(await assign(runId, "a", "k1", "acct_elsewhere")).toEqual({
      ok: false,
      code: "not_queued",
    });
    await drain(runId);
    const { jobId } = await jobNamed(runId, "a");
    expect(await minutesOf(f.owner.principalId, runId)).toEqual([
      expect.objectContaining({ key: `${runId}/j${jobId}/r1`, state: "released" }),
      expect.objectContaining({ key: `${runId}/j${jobId}/r2`, state: "held" }),
    ]);
    const answer = await assign(runId, "a", "k1", f.owner.principalId);
    expect(answer.ok).toBe(true);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 2, state: "running" });
  });

  it("reserves again under Free a job reserved on Paid before the plan changed, never assigning the Paid reservation", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    expect(await reservationOf(runId, "a")).toMatchObject({
      seq: 1,
      state: "reserved",
      price: null,
    });
    ciVariableOverrides.FYRDEN_PLAN = "free";
    expect(await inRun(runId, (r) => r.queued().length)).toBe(0);
    expect(await assign(runId, "a", "k1", f.owner.principalId)).toEqual({
      ok: false,
      code: "not_queued",
    });
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({
      seq: 2,
      state: "reserved",
      minutes: 180,
    });
    expect(await receiptsOf(runId)).toEqual([
      expect.objectContaining({ kind: "job", state: "granted", minutes: 180 }),
    ]);
    const answer = await assign(runId, "a", "k2", f.owner.principalId);
    expect(answer.ok && answer.timeoutMinutes).toBe(180);
  });

  it("reserves again under Paid a job priced on Free whose grant never ran, so a later Free never takes it as granted", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const spec = specFor(f, one);
    await moveTo(t, spec.runId);
    expect((await startRun(env, spec)).ok).toBe(true);
    // Priced on Free, its grant not yet answered.
    await inRun(spec.runId, (r) => {
      r.hooks = {
        beforeCiCall: () => {
          throw new Error("the ledger is unreachable");
        },
      };
    });
    await drain(spec.runId);
    expect(await reservationOf(spec.runId, "a")).toMatchObject({
      seq: 1,
      state: "wanted",
      price: expect.any(String),
    });
    await inRun(spec.runId, (r) => {
      r.hooks = {};
    });
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    await moveTo(t + 10 * MIN, spec.runId);
    await drain(spec.runId);
    expect(await reservationOf(spec.runId, "a")).toMatchObject({
      seq: 2,
      state: "reserved",
      price: null,
    });
    const { jobId } = await jobNamed(spec.runId, "a");
    expect(await receiptsOf(spec.runId)).toEqual([
      expect.objectContaining({ key: `${spec.runId}/j${jobId}/r1`, state: "released" }),
    ]);
    ciVariableOverrides.FYRDEN_PLAN = "free";
    expect(await assign(spec.runId, "a", "k", f.owner.principalId)).toEqual({
      ok: false,
      code: "not_queued",
    });
  });

  it("is published again, reserved as it was, when an assignment no runner was given is undone", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    const answer = await assign(runId, "a", "k1", f.owner.principalId);
    if (!answer.ok) throw new Error(answer.code);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "running" });
    expect(await inRun(runId, (r) => r.requeueTask(answer.task))).toBe(true);
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({
      seq: 1,
      state: "reserved",
      started_at: null,
    });
    expect((await pendingOf(runId)).map((p) => p.job_id)).toEqual([answer.task.jobId]);
    expect(await receiptsOf(runId)).toEqual([
      expect.objectContaining({ kind: "job", state: "granted" }),
    ]);
    expect((await assign(runId, "a", "k2", f.owner.principalId)).ok).toBe(true);
  });
});

describe("a job queued before its run reserved", () => {
  /** As an account object from before reservations held minutes. */
  const forgetMinutes = (accountId: string, runId: string) =>
    runInDurableObject(env.ORG.getByName(accountId), (_, state) => {
      state.storage.sql.exec("DELETE FROM ci_minutes WHERE key LIKE ?", `${runId}/%`);
    });

  it("is clamped and priced at Free's longest job once its run's object is upgraded", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    const { jobId } = await jobNamed(runId, "a");
    // Back to the v7 schema, its default-timeout job queued, then migrated again as a
    // deployment's upgrade migrates it, now on Free.
    await inRun(runId, (r) => {
      expect(r.engine.instance(jobId)?.timeout_ms).toBe(360 * MIN);
      r.engine.exec("DROP TABLE ci_reservations");
      r.engine.exec("ALTER TABLE ci_log_tickets DROP COLUMN read_checks");
      r.engine.exec("ALTER TABLE ci_log_tickets DROP COLUMN read_gets");
      r.engine.exec("ALTER TABLE ci_log_tickets DROP COLUMN read_bytes");
      r.engine.exec("DELETE FROM jobs WHERE kind = 'ci_reserve'");
      r.engine.exec("UPDATE _fyrden_schema_version SET version = 7");
      applyDoMigrations(r.context.storage as DurableObjectStorage, runSchema);
    });
    await forgetMinutes(f.owner.principalId, runId);
    ciVariableOverrides.FYRDEN_PLAN = "free";
    await moveTo(t + 5 * MIN, runId);
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({ state: "reserved", minutes: 180 });
    expect(await minutesOf(f.owner.principalId, runId)).toEqual([
      expect.objectContaining({ key: `${runId}/j${jobId}/r1`, reserved: 180, state: "held" }),
    ]);
    expect(await receiptsOf(runId)).toEqual([
      expect.objectContaining({ kind: "job", state: "granted", minutes: 180 }),
    ]);
    expect(await inRun(runId, (r) => r.engine.instance(jobId)?.timeout_ms)).toBe(180 * MIN);
    const answer = await assign(runId, "a", "k", f.owner.principalId);
    expect(answer.ok && answer.timeoutMinutes).toBe(180);
    expect(answer.ok && payloadTimeout(answer.payload)).toBe(180);
  });

  it("reserves once the run's next dispatch pass finds it", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    const { jobId } = await jobNamed(runId, "a");
    // As an object upgraded with the job queued finds it: wanted, its reserve slice not scheduled.
    await inRun(runId, (r) => {
      r.engine.exec(
        `UPDATE ci_reservations SET seq = 1, state = 'wanted', key = NULL, account_id = NULL,
           minutes = NULL, price = NULL, span_ms = NULL, fixed_at = NULL, valid_until = NULL,
           settle_by = NULL, window_until = NULL`,
      );
      r.engine.exec("DELETE FROM jobs WHERE kind = 'ci_reserve'");
    });
    await forgetMinutes(f.owner.principalId, runId);
    await moveTo(t + 5 * MIN, runId);
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "reserved" });
    expect(await minutesOf(f.owner.principalId, runId)).toEqual([
      expect.objectContaining({ key: `${runId}/j${jobId}/r1`, reserved: 360, state: "held" }),
    ]);
    expect((await pendingOf(runId)).map((p) => p.job_id)).toEqual([jobId]);
  });
});

describe("a job no runner may take", () => {
  const setVisibility = (repoId: string, visibility: "public" | "private") =>
    env.DIRECTORY.prepare("UPDATE repos SET visibility = ? WHERE id = ?")
      .bind(visibility, repoId)
      .run();
  const forkRun: Partial<RunSpec> = {
    event: "pull_request",
    ref: "refs/pull/1/head",
    github: { event_name: "pull_request", workflow: "ci" },
    trust: "untrusted",
    fork: true,
  };

  it.each(["a fork job", "a public repository's job"] as const)(
    "%s is never reserved or published, and costs nothing in either store",
    async (which) => {
      const t = await today();
      const f = await orgRepo();
      if (which === "a public repository's job") await setVisibility(f.repo.id, "public");
      const spec = specFor(f, one, which === "a fork job" ? forkRun : {});
      await moveTo(t, spec.runId);
      const calls = await recordCalls(spec.runId);
      expect((await startRun(env, spec)).ok).toBe(true);
      await drain(spec.runId);
      const runId = spec.runId;
      expect((await jobNamed(runId, "a")).status).toBe("queued");
      const row = await reservationOf(runId, "a");
      expect(row).toMatchObject({ seq: 1, state: "wanted", key: null, waiting_for: null });
      expect(row.ineligible_at).toBe(t);
      expect((await jobNamed(runId, "a")).waitingFor).toBeNull();
      expect(calls).toEqual([]);
      expect(await pendingOf(runId)).toEqual([]);
      expect(await receiptsOf(runId)).toEqual([]);
      expect(await minutesOf(f.org.id, runId)).toEqual([]);
      expect(await dayOf(t)).toBeNull();
      await moveTo(t + 5 * MIN, runId);
      await drain(runId);
      expect(calls).toEqual([]);
      expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "wanted" });
      await runStub(runId).cancel(f.owner.principalId, "graceful");
      await drain(runId);
      expect(await reservationOf(runId, "a")).toMatchObject({ state: "settled", key: null });
      expect(calls).toEqual([]);
    },
  );

  it("reserves a job once its repository is made private, at the run's next dispatch pass", async () => {
    const t = await today();
    const f = await orgRepo();
    await setVisibility(f.repo.id, "public");
    const runId = await startedAt(f, one, t);
    expect(await reservationOf(runId, "a")).toMatchObject({ state: "wanted", key: null });
    await setVisibility(f.repo.id, "private");
    await moveTo(t + 5 * MIN, runId);
    await drain(runId);
    const { jobId } = await jobNamed(runId, "a");
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "reserved" });
    expect(await pendingOf(runId)).toEqual([expect.objectContaining({ job_id: jobId })]);
  });

  it("never assigns a reserved job whose repository turns public; its window lapses and it waits", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const t = await today();
    const f = await orgRepo();
    const runId = await startedAt(f, one, t);
    expect(await reservationOf(runId, "a")).toMatchObject({ state: "reserved" });
    await setVisibility(f.repo.id, "public");
    const runner = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(runId)).toEqual([]);
    await moveTo(t + 30 * MIN, runId);
    await drain(runId);
    const { jobId } = await jobNamed(runId, "a");
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 2, state: "wanted", key: null });
    expect(await minutesOf(f.org.id, runId)).toEqual([
      expect.objectContaining({ key: `${runId}/j${jobId}/r1`, state: "released" }),
    ]);
    expect(await pendingOf(runId)).toEqual([]);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect((await jobNamed(runId, "a")).status).toBe("queued");
  });
});

describe("the daily allowance on Free", () => {
  it("refuses a job without writing anything or asking its account, shows why, and admits it after the day turns", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const spec = specFor(f, two);
    await moveTo(t, spec.runId);
    const calls = await recordCalls(spec.runId);
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    const runId = spec.runId;
    const a = await jobNamed(runId, "a");
    const b = await jobNamed(runId, "b");
    // One 180-minute job fits Free's default share of a day; the second does not.
    expect(await pendingOf(runId)).toEqual([expect.objectContaining({ job_id: a.jobId })]);
    const refused = await reservationOf(runId, "b");
    expect(refused).toMatchObject({ seq: 1, state: "refused", waiting_for: "daily_capacity" });
    const midnight = (Math.floor(t / DAY) + 1) * DAY;
    expect(refused.retry_at).toBeGreaterThanOrEqual(midnight);
    expect(refused.retry_at).toBeLessThanOrEqual(midnight + MIN);
    const bKey = `${runId}/j${b.jobId}/r1`;
    expect(calls.filter((c) => c.key === bKey).map((c) => c.op)).toEqual(["grant"]);
    expect((await receiptsOf(runId)).map((r) => r.key)).toEqual([`${runId}/j${a.jobId}/r1`]);
    expect((await minutesOf(f.owner.principalId, runId)).map((r) => r.key)).toEqual([
      `${runId}/j${a.jobId}/r1`,
    ]);
    const listed = await json<{ jobs: { name: string; waiting_for: string | null }[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs`, f.owner.token),
    );
    expect(listed.body.jobs.map((j) => [j.name, j.waiting_for])).toEqual([
      ["a", null],
      ["b", "daily_capacity"],
    ]);

    // `a` runs, so its window cannot lapse. The day turns (D1's clock with it): `b` is asked
    // again now rather than at its retry time.
    expect((await assign(runId, "a", "k", f.owner.principalId)).ok).toBe(true);
    await moveTo(midnight + 1, runId);
    const states = await runStub(runId).ciReserveNow();
    expect(states).toContainEqual(
      expect.objectContaining({ jobId: b.jobId, seq: 2, state: "reserved", waitingFor: null }),
    );
    await drain(runId);
    expect((await pendingOf(runId)).map((p) => p.job_id)).toEqual([b.jobId]);
    expect((await jobsOf(runId)).map((j) => j.waitingFor)).toEqual([null, null]);
  });

  it("gives the ledger back its per-minute part when the account refuses, keeping the fixed part", async () => {
    const t = await today();
    const f = await repoWithCommit();
    await moveTo(t);
    // The account has 100 of its 2,000 minutes left this month.
    await env.ORG.getByName(f.owner.principalId).reserveCiMinutes({
      key: `elsewhere/${t}`,
      agentId: null,
      minutes: 1_900,
      validUntil: t + 10 * MIN,
      settleBy: t + 5 * HOUR,
    });
    const spec = specFor(f, one);
    await moveTo(t, spec.runId);
    const calls = await recordCalls(spec.runId);
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    const runId = spec.runId;
    const { jobId } = await jobNamed(runId, "a");
    const key = `${runId}/j${jobId}/r1`;
    expect(calls.map((c) => c.op)).toEqual([
      "grant",
      "reserve",
      "minutes_release",
      "ledger_release",
    ]);
    expect(await receiptsOf(runId)).toEqual([
      { key, kind: "job", state: "released", minutes: 180 },
    ]);
    expect(await dayOf(t)).toMatchObject({
      do_requests: CI_JOB_FIXED.do_requests,
      d1_rows_written: CI_JOB_FIXED.d1_rows_written,
      worker_requests: 0,
      do_duration_ms: 0,
    });
    const refused = await reservationOf(runId, "a");
    expect(refused).toMatchObject({ state: "refused", waiting_for: "ci_minutes" });
    expect(refused.retry_at).toBeGreaterThanOrEqual((Math.floor(t / DAY) + 1) * DAY);
    expect(await pendingOf(runId)).toEqual([]);
    expect((await jobNamed(runId, "a")).waitingFor).toBe("ci_minutes");
  });

  it("never runs a key whose release after the account's refusal lost its answer", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const account = env.ORG.getByName(f.owner.principalId);
    const elsewhere = `elsewhere/${t}`;
    await account.reserveCiMinutes({
      key: elsewhere,
      agentId: null,
      minutes: 1_900,
      validUntil: t + 10 * MIN,
      settleBy: t + 5 * HOUR,
    });
    const spec = specFor(f, one);
    await moveTo(t, spec.runId);
    await inRun(spec.runId, (r) => {
      let lost = false;
      r.hooks = {
        afterCiCall: (op) => {
          if (op !== "ledger_release" || lost) return;
          lost = true;
          throw new Error("the answer was lost");
        },
      };
    });
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    const runId = spec.runId;
    const { jobId } = await jobNamed(runId, "a");
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "minutes" });
    // The account has room again before the slice asks again with the same key.
    await account.releaseCiMinutes(elsewhere);
    await moveTo(t + MIN, runId);
    await drain(runId);
    // Answered released, it waits a minute before it asks under seq 2.
    await moveTo(t + 3 * MIN, runId);
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 2, state: "reserved" });
    expect((await receiptsOf(runId)).map((r) => [r.key, r.state])).toEqual([
      [`${runId}/j${jobId}/r1`, "released"],
      [`${runId}/j${jobId}/r2`, "granted"],
    ]);
    expect((await minutesOf(f.owner.principalId, runId)).map((r) => [r.key, r.state])).toEqual([
      [`${runId}/j${jobId}/r1`, "released"],
      [`${runId}/j${jobId}/r2`, "held"],
    ]);
  });

  it("fails a job whose minutes no month of its account can hold at once, with an annotation", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    ciVariableOverrides.QUOTA_CI_MINUTES = "300";
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    const a = await jobNamed(runId, "a");
    expect(a).toMatchObject({ status: "completed", conclusion: "failure", waitingFor: null });
    expect(a.error).toMatch(/^ci_too_large: .*360 minutes.*300/);
    expect(await pendingOf(runId)).toEqual([]);
    expect(await reservationOf(runId, "a")).toMatchObject({ state: "settled" });
    expect(await minutesOf(f.owner.principalId, runId)).toEqual([
      expect.objectContaining({ state: "released", reserved: 0 }),
    ]);
  });

  it("fails a job priced above the allowance at once, with an annotation", async () => {
    ciVariableOverrides.FYRDEN_CI_DAILY = "do_requests=1000";
    const t = await today();
    const f = await repoWithCommit();
    const spec = specFor(f, one);
    await moveTo(t, spec.runId);
    const calls = await recordCalls(spec.runId);
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    const a = await jobNamed(spec.runId, "a");
    expect(a).toMatchObject({ status: "completed", conclusion: "failure", waitingFor: null });
    expect(a.error).toMatch(/^ci_too_large: /);
    expect(calls.some((c) => c.op === "reserve")).toBe(false);
    expect(await pendingOf(spec.runId)).toEqual([]);
    expect(await reservationOf(spec.runId, "a")).toMatchObject({ state: "settled" });
    expect(await receiptsOf(spec.runId)).toEqual([
      expect.objectContaining({ kind: null, state: "released" }),
    ]);
  });

  it("clamps a job's timeout to 180 minutes, in its deadline and its price; Paid keeps it", async () => {
    const source = workflow(job("a", ["timeout-minutes: 360"]));
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, source, t);
    expect(await reservationOf(runId, "a")).toMatchObject({ state: "reserved", minutes: 180 });
    expect((await receiptsOf(runId))[0]?.minutes).toBe(180);
    const answer = await assign(runId, "a", "k", f.owner.principalId);
    expect(answer.ok && answer.timeoutMinutes).toBe(180);
    expect(answer.ok && payloadTimeout(answer.payload)).toBe(180);
    const { jobId } = await jobNamed(runId, "a");
    const row = await inRun(runId, (r) => r.engine.instance(jobId));
    expect(row && { timeout: row.timeout_ms, started: row.started_at }).toEqual({
      timeout: 180 * MIN,
      started: t,
    });

    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const later = await today();
    const paid = await startedAt(await repoWithCommit(), source, later);
    expect(await reservationOf(paid, "a")).toMatchObject({ state: "reserved", minutes: 360 });
    expect(await receiptsOf(paid)).toEqual([]);
  });
});

describe("a refused job", () => {
  it("asks again when the month resets once its minutes are spent, and at most three times", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    ciVariableOverrides.QUOTA_CI_MINUTES = "2000";
    const t = await today();
    const f = await repoWithCommit();
    // Spent for good: a hold past its settlement time counts as used.
    await env.ORG.getByName(f.owner.principalId).reserveCiMinutes({
      key: `spent/${t}`,
      agentId: null,
      minutes: 1_900,
      validUntil: t + 10 * MIN,
      settleBy: t - 1,
    });
    const spec = specFor(f, one);
    await moveTo(t, spec.runId);
    const calls = await recordCalls(spec.runId);
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    const runId = spec.runId;
    const first = await reservationOf(runId, "a");
    expect(first).toMatchObject({ state: "refused", refusals: 1, waiting_for: "ci_minutes" });
    const month = new Date(t);
    const reset = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1);
    expect(first.retry_at).toBeGreaterThanOrEqual(reset);
    expect(first.retry_at).toBeLessThanOrEqual(reset + MIN);

    await runStub(runId).ciReserveNow();
    await runStub(runId).ciReserveNow();
    expect(await reservationOf(runId, "a")).toMatchObject({
      state: "refused",
      refusals: 3,
      retry_at: null,
      waiting_for: "ci_minutes",
    });
    await runStub(runId).ciReserveNow();
    expect(calls.filter((c) => c.op === "reserve")).toHaveLength(3);
    expect((await jobNamed(runId, "a")).waitingFor).toBe("ci_minutes");
  });
});

describe("answers lost or late", () => {
  it("asks the account again with the same key after a lost answer: one hold", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const spec = specFor(f, one);
    await moveTo(t, spec.runId);
    await inRun(spec.runId, (r) => {
      let lost = false;
      r.hooks = {
        afterCiCall: (op) => {
          if (op !== "reserve" || lost) return;
          lost = true;
          throw new Error("the answer was lost");
        },
      };
    });
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    const runId = spec.runId;
    const { jobId } = await jobNamed(runId, "a");
    const key = `${runId}/j${jobId}/r1`;
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "minutes", key });
    expect(await minutesOf(f.owner.principalId, runId)).toEqual([
      { key, reserved: 180, used: 0, state: "held" },
    ]);
    await moveTo(t + MIN, runId);
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "reserved", key });
    expect(await minutesOf(f.owner.principalId, runId)).toEqual([
      { key, reserved: 180, used: 0, state: "held" },
    ]);
  });

  it("releases a key answered expired and asks again under the next seq", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const spec = specFor(f, one);
    await moveTo(t);
    // The run's clock an hour behind D1's: its key is past its validity when the ledger reads it.
    await at(spec.runId, t - HOUR);
    await inRun(spec.runId, (r) => {
      r.hooks = {
        afterCiCall: (op) => {
          if (op === "ledger_release") (r.context as { now: () => number }).now = () => t;
        },
      };
    });
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    // The hook moved the run's clock on, which ended that alarm; the next asks under seq 2, a
    // minute after the expired answer.
    await at(spec.runId, t + MIN);
    await drain(spec.runId);
    const runId = spec.runId;
    const { jobId } = await jobNamed(runId, "a");
    expect(await receiptsOf(runId)).toEqual([
      { key: `${runId}/j${jobId}/r1`, kind: null, state: "released", minutes: null },
      { key: `${runId}/j${jobId}/r2`, kind: "job", state: "granted", minutes: 180 },
    ]);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 2, state: "reserved" });
  });

  it("stops asking after a store keeps answering expired: the run's clock persistently behind", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const spec = specFor(f, one);
    const behind = 11 * MIN;
    await moveTo(t);
    await at(spec.runId, t - behind);
    const calls = await recordCalls(spec.runId);
    expect((await startRun(env, spec)).ok).toBe(true);
    await drain(spec.runId);
    const runId = spec.runId;
    // Time passes on every clock; the offset is never repaired.
    for (let i = 1; i <= 8; i++) {
      await moveTo(t + i * 5 * MIN);
      await at(runId, t + i * 5 * MIN - behind);
      await drain(runId);
    }
    const ops = (op: CiCall) => calls.filter((c) => c.op === op).length;
    expect(ops("grant")).toBe(3);
    expect(ops("ledger_release")).toBe(3);
    expect(ops("reserve")).toBe(0);
    expect(await reservationOf(runId, "a")).toMatchObject({
      seq: 3,
      state: "refused",
      refusals: 3,
      retry_at: null,
    });
    expect((await receiptsOf(runId)).map((r) => [r.kind, r.state])).toEqual([
      [null, "released"],
      [null, "released"],
      [null, "released"],
    ]);
  });

  it.each([
    ["before", "grant"],
    ["after", "grant"],
    ["before", "reserve"],
    ["after", "reserve"],
  ] as const)(
    "a cancel %s the %s commits, its answer lost: both stores end released",
    async (when, op) => {
      const t = await today();
      const f = await repoWithCommit();
      const spec = specFor(f, one);
      await moveTo(t, spec.runId);
      await inRun(spec.runId, (r) => {
        let done = false;
        const cancel = (called: CiCall) => {
          if (called !== op || done) return;
          done = true;
          r.cancel(f.owner.principalId, "graceful");
          if (when === "after") throw new Error("the answer was lost");
        };
        r.hooks = when === "before" ? { beforeCiCall: cancel } : { afterCiCall: cancel };
      });
      expect((await startRun(env, spec)).ok).toBe(true);
      await drain(spec.runId);
      await moveTo(t + MIN, spec.runId);
      await drain(spec.runId);
      const runId = spec.runId;
      const { jobId } = await jobNamed(runId, "a");
      const key = `${runId}/j${jobId}/r1`;
      expect((await jobNamed(runId, "a")).conclusion).toBe("cancelled");
      expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "settled" });
      expect(await receiptsOf(runId)).toEqual([
        expect.objectContaining({ key, state: "released" }),
      ]);
      expect(await minutesOf(f.owner.principalId, runId)).toEqual([
        expect.objectContaining({ key, used: 0, state: "released" }),
      ]);
      expect(await dayOf(t)).toMatchObject({ worker_requests: 0, do_duration_ms: 0 });
      expect(await pendingOf(runId)).toEqual([]);
    },
  );
});

describe("the start window", () => {
  it("lapses: withdrawn, released and reserved again, each lapse's control work kept", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    const { jobId } = await jobNamed(runId, "a");
    expect((await pendingOf(runId)).map((p) => p.job_id)).toEqual([jobId]);

    await moveTo(t + 30 * MIN, runId);
    await drain(runId);
    await moveTo(t + 60 * MIN, runId);
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 3, state: "reserved" });
    expect((await receiptsOf(runId)).map((r) => [r.key, r.state])).toEqual([
      [`${runId}/j${jobId}/r1`, "released"],
      [`${runId}/j${jobId}/r2`, "released"],
      [`${runId}/j${jobId}/r3`, "granted"],
    ]);
    expect((await minutesOf(f.owner.principalId, runId)).map((r) => r.state)).toEqual([
      "released",
      "released",
      "held",
    ]);
    // Three reservations' fixed parts, one job's minutes.
    expect(await dayOf(t)).toMatchObject({
      do_requests: 3 * CI_JOB_FIXED.do_requests + 45 * 180,
      worker_requests: 45 * 180,
    });
    expect((await pendingOf(runId)).map((p) => p.job_id)).toEqual([jobId]);
  });

  it("does not stop a replayed assignment: the same task after the window lapsed", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, two, t);
    const first = await assign(runId, "a", "k-a", f.owner.principalId);
    expect(first.ok).toBe(true);
    await at(runId, t + 2 * HOUR);
    expect(await assign(runId, "a", "k-a", f.owner.principalId)).toEqual(first);
    expect(await assign(runId, "b", "k-b", f.owner.principalId)).toEqual({
      ok: false,
      code: "not_queued",
    });
  });
});

describe("the end of a job", () => {
  it("settles a finished task at the minutes it ran, in both stores", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    const answer = await assign(runId, "a", "k", f.owner.principalId);
    if (!answer.ok) throw new Error(answer.code);
    await moveTo(t + 20 * MIN + 1_000, runId);
    expect(
      (await runStub(runId).completeTask(answer.task, { result: "success", logComplete: true })).ok,
    ).toBe(true);
    await drain(runId);
    const { jobId } = await jobNamed(runId, "a");
    const key = `${runId}/j${jobId}/r1`;
    expect(await reservationOf(runId, "a")).toMatchObject({ state: "settled" });
    expect(await minutesOf(f.owner.principalId, runId)).toEqual([
      { key, reserved: 180, used: 21, state: "settled" },
    ]);
    expect(await receiptsOf(runId)).toEqual([{ key, kind: "job", state: "settled", minutes: 180 }]);
    expect(await dayOf(t)).toMatchObject({
      worker_requests: 45 * 21,
      do_requests: CI_JOB_FIXED.do_requests + 45 * 21,
    });
  });

  it.each(["in progress", "cancelling"])(
    "releases a job %s that failed before any runner was given it, in both stores",
    async (status) => {
      const t = await today();
      const f = await repoWithCommit();
      const runId = await startedAt(f, one, t);
      const answer = await assign(runId, "a", "k", f.owner.principalId);
      if (!answer.ok) throw new Error(answer.code);
      if (status === "cancelling") await runStub(runId).cancel(f.owner.principalId, "graceful");
      await moveTo(t + 90_000, runId);
      expect(await inRun(runId, (r) => r.failTask(answer.task, "its secrets do not open"))).toBe(
        true,
      );
      expect(await jobNamed(runId, "a")).toMatchObject({ status: "completed" });
      await drain(runId);
      const { jobId } = await jobNamed(runId, "a");
      const key = `${runId}/j${jobId}/r1`;
      expect(await reservationOf(runId, "a")).toMatchObject({ state: "settled", started_at: null });
      expect(await minutesOf(f.owner.principalId, runId)).toEqual([
        { key, reserved: 180, used: 0, state: "released" },
      ]);
      expect((await receiptsOf(runId)).map((r) => r.state)).toEqual(["released"]);
      expect(await dayOf(t)).toMatchObject({
        do_requests: CI_JOB_FIXED.do_requests,
        worker_requests: 0,
      });
    },
  );

  it("keeps a finished job's settlement when a failure of its delivery comes late", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    const answer = await assign(runId, "a", "k", f.owner.principalId);
    if (!answer.ok) throw new Error(answer.code);
    await moveTo(t + 20 * MIN, runId);
    expect(
      (await runStub(runId).completeTask(answer.task, { result: "success", logComplete: true })).ok,
    ).toBe(true);
    expect(await inRun(runId, (r) => r.failTask(answer.task, "its secrets do not open"))).toBe(
      false,
    );
    await drain(runId);
    expect(await minutesOf(f.owner.principalId, runId)).toMatchObject([
      { used: 20, state: "settled" },
    ]);
  });

  it("releases a job cancelled while queued, with no task, in both stores", async () => {
    const t = await today();
    const f = await repoWithCommit();
    const runId = await startedAt(f, one, t);
    await runStub(runId).cancel(f.owner.principalId, "graceful");
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({ state: "settled" });
    expect((await receiptsOf(runId)).map((r) => r.state)).toEqual(["released"]);
    expect((await minutesOf(f.owner.principalId, runId)).map((r) => r.state)).toEqual(["released"]);
    expect(await dayOf(t)).toMatchObject({
      do_requests: CI_JOB_FIXED.do_requests,
      worker_requests: 0,
    });
  });
});

describe("a repository that moves", () => {
  async function transfer(f: Fixture & { org: { login: string } }, to: string) {
    const moved = await json<{ state: string }>(
      api("POST", `/repos/${f.org.login}/${f.repo.name}/transfer`, f.owner.token, {
        new_owner: to,
      }),
    );
    expect(moved).toMatchObject({ status: 200, body: { state: "transferred" } });
  }

  it("before its job is assigned: reserved again under the new owner, and published there", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const t = await today();
    const f = await orgRepo();
    const to = await newOrg(f.owner);
    const runId = await startedAt(f, one, t);
    const { jobId } = await jobNamed(runId, "a");
    await transfer(f, to.login);
    // The run looks again within its resync interval.
    await moveTo(t + 5 * MIN, runId);
    await drain(runId);
    expect(await minutesOf(f.org.id, runId)).toEqual([
      expect.objectContaining({ key: `${runId}/j${jobId}/r1`, state: "released" }),
    ]);
    expect(await minutesOf(to.id, runId)).toEqual([
      expect.objectContaining({ key: `${runId}/j${jobId}/r2`, state: "held" }),
    ]);
    expect(await pendingOf(runId)).toEqual([expect.objectContaining({ account_id: to.id })]);
    expect(await assign(runId, "a", "k", to.id)).toMatchObject({ ok: true });
  });

  it("ends a job marked for the new owner without reserving for it again", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const t = await today();
    const f = await orgRepo();
    const to = await newOrg(f.owner);
    const runId = await startedAt(f, one, t);
    await transfer(f, to.login);
    // The run has learnt of the move (marked for the new owner) when the job is cancelled,
    // before its reserve slice runs again.
    await inRun(runId, (r) => r.engine.exec("UPDATE ci_reservations SET rebind = 1"));
    expect(await runStub(runId).cancel(f.owner.principalId, "graceful")).toMatchObject({
      ok: true,
    });
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "settled" });
    await moveTo(t + 40 * MIN, runId);
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({ seq: 1, state: "settled" });
    expect(await minutesOf(to.id, runId)).toEqual([]);
  });

  it("while its job waits refused: reserved again under the new owner at the next resync", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    ciVariableOverrides.QUOTA_CI_MINUTES = "2000";
    const t = await today();
    const f = await orgRepo();
    const to = await newOrg(f.owner);
    // The old account's month is spent for good.
    await env.ORG.getByName(f.org.id).reserveCiMinutes({
      key: `spent/${t}`,
      agentId: null,
      minutes: 1_900,
      validUntil: t + 10 * MIN,
      settleBy: t - 1,
    });
    const runId = await startedAt(f, one, t);
    expect(await reservationOf(runId, "a")).toMatchObject({
      state: "refused",
      refusals: 1,
      account_id: f.org.id,
    });
    await transfer(f, to.login);
    await moveTo(t + 5 * MIN, runId);
    await drain(runId);
    const { jobId } = await jobNamed(runId, "a");
    expect(await reservationOf(runId, "a")).toMatchObject({
      seq: 2,
      state: "reserved",
      refusals: 0,
      account_id: to.id,
      waiting_for: null,
    });
    expect(await minutesOf(f.org.id, runId)).toEqual([
      expect.objectContaining({ key: `${runId}/j${jobId}/r1`, state: "released" }),
    ]);
    expect(await minutesOf(to.id, runId)).toEqual([
      expect.objectContaining({ key: `${runId}/j${jobId}/r2`, state: "held" }),
    ]);
    expect(await pendingOf(runId)).toEqual([expect.objectContaining({ account_id: to.id })]);
  });

  it("just before its refused job asks again: the new owner's asks start again", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    ciVariableOverrides.QUOTA_CI_MINUTES = "2000";
    const t = await today();
    const f = await orgRepo();
    const to = await newOrg(f.owner);
    await env.ORG.getByName(f.org.id).reserveCiMinutes({
      key: `spent/${t}`,
      agentId: null,
      minutes: 1_900,
      validUntil: t + 10 * MIN,
      settleBy: t - 1,
    });
    const runId = await startedAt(f, one, t);
    // Two asks spent on the old account, the next due before the run's next resync.
    await runInDurableObject(runStub(runId), (_, state) => {
      state.storage.sql.exec(
        "UPDATE ci_reservations SET refusals = 2, retry_at = ? WHERE state = 'refused'",
        t + MIN,
      );
    });
    await transfer(f, to.login);
    await moveTo(t + MIN, runId);
    // The retry, ahead of the run's next resync (which would rebind the reservation itself).
    await runStub(runId).ciReserveNow();
    await drain(runId);
    expect(await reservationOf(runId, "a")).toMatchObject({
      state: "reserved",
      refusals: 0,
      account_id: to.id,
      asked_for: to.id,
      waiting_for: null,
    });
  });

  it("while its job runs: settled against the account it was reserved for", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    const t = await today();
    const f = await orgRepo();
    const to = await newOrg(f.owner);
    const runId = await startedAt(f, one, t);
    const answer = await assign(runId, "a", "k", f.org.id);
    if (!answer.ok) throw new Error(answer.code);
    await transfer(f, to.login);
    await moveTo(t + 5 * MIN, runId);
    await runStub(runId).completeTask(answer.task, { result: "success", logComplete: true });
    await drain(runId);
    expect(await minutesOf(f.org.id, runId)).toEqual([
      expect.objectContaining({ used: 5, state: "settled" }),
    ]);
    expect(await minutesOf(to.id, runId)).toEqual([]);
  });
});
