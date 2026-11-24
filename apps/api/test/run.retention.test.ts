// A run's retention: a run whose latest attempt completed more than the
// retention ago is expired, and every operation on it answers as for a run
// that does not exist; a re-run restarts the clock; a run not completed
// never expires; and the run's weekly check is moved to its expiry.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RUN_JOB } from "../src/do/run/engine.js";
import { runRetentionDays } from "../src/do/run/retention.js";
import {
  at,
  drain,
  finish,
  inRun,
  job,
  repoWithCommit,
  runStub,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 2 * DAY;

/** A run of one job, its retention `RETENTION`, completed at `T0`; its id. */
async function completedRun(): Promise<string> {
  const f = await repoWithCommit();
  const runId = await started(f, workflow(job("build")));
  await setRetention(runId);
  await finish(runId, "build");
  const view = await runStub(runId).get();
  expect(view?.status).toBe("completed");
  return runId;
}

const setRetention = (runId: string) =>
  inRun(runId, (run) => {
    run.policy = { ...run.policy, retentionMs: RETENTION };
  });

/** Every run operation's answer, as `found` or the refusal it gives for a run that is gone. */
async function visibility(runId: string) {
  await setRetention(runId);
  const run = runStub(runId);
  const cancelled = await run.cancel("usr_x", "graceful");
  return {
    get: (await run.get()) !== undefined,
    jobs: (await run.listJobs()) !== undefined,
    cancel: cancelled.ok ? "ok" : cancelled.code,
    approve: ((await run.approve("b", "usr_x")) as { ok: boolean; code?: string }).code,
    ticket: (
      (await run.storeLogTicket({
        hash: "h".repeat(64),
        repoId: (await inRun(runId, (r) => r.engine.run()?.repo_id)) ?? "",
        jobId: 1,
        credentialId: "c",
        principalId: "usr_x",
        budget: null,
      })) as { ok: boolean; code?: string }
    ).code,
  };
}

const HIDDEN = {
  get: false,
  jobs: false,
  cancel: "run_not_found",
  approve: "run_not_found",
  ticket: "run_not_found",
};

describe("run retention", () => {
  it("keeps a completed run until its retention ends, then answers as for no run", async () => {
    const runId = await completedRun();
    await at(runId, T0 + RETENTION - 1);
    expect(await visibility(runId)).toMatchObject({ get: true, jobs: true });
    await at(runId, T0 + RETENTION);
    expect(await visibility(runId)).toEqual(HIDDEN);
    await setRetention(runId);
    expect(await runStub(runId).rerun("usr_x")).toEqual({ ok: false, code: "run_not_found" });
  });

  it("restarts the clock on a re-run", async () => {
    const runId = await completedRun();
    const T2 = T0 + RETENTION - DAY;
    await at(runId, T2);
    await setRetention(runId);
    expect((await runStub(runId).rerun("usr_x")).ok).toBe(true);
    await drain(runId);
    await setRetention(runId);
    await finish(runId, "build");
    await at(runId, T0 + RETENTION);
    expect((await visibility(runId)).get).toBe(true);
    await at(runId, T2 + RETENTION);
    expect((await visibility(runId)).get).toBe(false);
  });

  it("never expires a run whose latest attempt has not completed", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("build")));
    await at(runId, T0 + 10 * RETENTION);
    expect((await visibility(runId)).get).toBe(true);
  });

  it("moves the run's weekly check to its expiry when an attempt completes", async () => {
    const runId = await completedRun();
    const next = await inRun(
      runId,
      (run) =>
        run.context.storage.sql
          .exec<{ next_run_at: number }>(
            "SELECT next_run_at FROM jobs WHERE job_id = ?",
            RUN_JOB.reconcile,
          )
          .one().next_run_at,
    );
    expect(next).toBe(T0 + RETENTION);
  });
});

describe("the run's weekly check", () => {
  it("is next due at the expiry when that comes before the next week's check", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("build")));
    const retention = 10 * DAY;
    const reconcileAt = () =>
      inRun(
        runId,
        (run) =>
          run.context.storage.sql
            .exec<{ next_run_at: number }>(
              "SELECT next_run_at FROM jobs WHERE job_id = ?",
              RUN_JOB.reconcile,
            )
            .one().next_run_at,
      );
    await inRun(runId, (run) => {
      run.policy = { ...run.policy, retentionMs: retention };
    });
    await finish(runId, "build");
    // A week is sooner than the expiry: the check created with the run keeps its time.
    expect(await reconcileAt()).toBe(T0 + 7 * DAY);
    await at(runId, T0 + 7 * DAY);
    await inRun(runId, (run) => {
      run.policy = { ...run.policy, retentionMs: retention };
    });
    await drain(runId);
    expect(await reconcileAt()).toBe(T0 + retention);
  });
});

describe("the retention setting", () => {
  it.each([
    [undefined, 90],
    ["30", 30],
    ["7", 7],
    ["400", 400],
    ["6", 90],
    ["0", 90],
    ["401", 90],
    ["1.5", 90],
    ["abc", 90],
    ["", 90],
  ])("reads %j as %d days", (value, days) => {
    const warnings: string[] = [];
    expect(
      runRetentionDays(
        value === undefined ? {} : { FYRDEN_CI_RUN_RETENTION_DAYS: value },
        (message) => warnings.push(message),
      ),
    ).toBe(days);
    expect(warnings).toHaveLength(value === undefined || days !== 90 || value === "90" ? 0 : 1);
  });

  it("is the deployment's setting in a new run object", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("build")));
    expect(await inRun(runId, (run) => run.policy.retentionMs)).toBe(
      runRetentionDays(env as object, () => {}) * DAY,
    );
  });
});
