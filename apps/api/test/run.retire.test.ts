// Retiring an expired run: its weekly check, due at its expiry, asks the
// repository to forget it, then erases it; a failure on the way is retried
// and never revives the run; a run not completed is never retired; and a
// trigger's start retried for a retiring run neither recreates nor
// re-records it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type StartRunAnswer, startRun } from "../src/ci/runs.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { RUN_JOB } from "../src/do/run/engine.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  at,
  drain,
  type Fixture,
  finish,
  inRun,
  job,
  ownerOf,
  repoWithCommit,
  runStub,
  specFor,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 2 * DAY;
const SOURCE = workflow(job("build"));

/** The run's retention set to `RETENTION`, and its hooks; kept on the live instance. */
const configure = (runId: string, hooks: Parameters<typeof inRun>[1] = () => {}) =>
  inRun(runId, async (run) => {
    run.policy = { ...run.policy, retentionMs: RETENTION };
    await hooks(run);
  });

async function completedRun(f?: Fixture) {
  const fixture = f ?? (await repoWithCommit());
  const runId = await started(fixture, SOURCE);
  await configure(runId);
  await finish(runId, "build");
  return { f: fixture, runId };
}

const recorded = (f: Fixture, runId: string) =>
  inRepo(
    env.REPO.getByName(f.repo.id),
    (r: RepoDO) =>
      r.git.context.storage.sql.exec("SELECT 1 FROM ci_runs WHERE run_id = ?", runId).toArray()
        .length > 0,
  );

const state = (runId: string) =>
  inRun(runId, (run) => ({
    erased: run.engine.rows("SELECT 1 FROM run_erasure").length > 0,
    jobs: run.engine
      .rows<{ job_id: string; state: string }>("SELECT job_id, state FROM jobs ORDER BY job_id")
      .map((row) => `${row.job_id}:${row.state}`),
  }));

/** Moves the run's clock to `t`, its retention set, and runs what is due. */
async function runAt(runId: string, t: number) {
  await at(runId, t);
  await configure(runId);
  await drain(runId);
}

describe("retiring an expired run", () => {
  it("keeps the run before its expiry, and forgets and erases it at its expiry", async () => {
    const { f, runId } = await completedRun();
    await runAt(runId, T0 + RETENTION - 1);
    expect(await recorded(f, runId)).toBe(true);
    expect((await state(runId)).erased).toBe(false);
    await runAt(runId, T0 + RETENTION);
    expect(await recorded(f, runId)).toBe(false);
    // Only its log purge is left, due once a log write in flight would have landed.
    expect(await state(runId)).toEqual({ erased: true, jobs: [`${RUN_JOB.logPurge}:queued`] });
    expect(await runStub(runId).get()).toBeUndefined();
  });

  it("never retires a run whose latest attempt has not completed", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, SOURCE);
    await runAt(runId, T0 + 10 * RETENTION);
    expect(await recorded(f, runId)).toBe(true);
    expect((await state(runId)).erased).toBe(false);
  });

  it("retries a failed forget at the sweep's interval, the run intact, then retires it", async () => {
    const { f, runId } = await completedRun();
    await at(runId, T0 + RETENTION);
    await configure(runId, (run) => {
      run.hooks.beforeRepoCall = (op) => {
        if (op === "forgetRun") throw new Error("the repository could not be reached");
      };
    });
    await drain(runId);
    expect(await recorded(f, runId)).toBe(true);
    expect((await state(runId)).erased).toBe(false);
    const retry = await inRun(runId, (run) => ({
      next: run.engine.rows<{ next_run_at: number; attempts: number }>(
        "SELECT next_run_at, attempts FROM jobs WHERE job_id = ?",
        RUN_JOB.retire,
      )[0],
      sweep: run.policy.sweepMs,
    }));
    expect(retry.next).toEqual({ next_run_at: T0 + RETENTION + retry.sweep, attempts: 0 });
    // Still answered as no run while it waits.
    expect(await runStub(runId).get()).toBeUndefined();
    await configure(runId, (run) => {
      delete run.hooks.beforeRepoCall;
    });
    await runAt(runId, T0 + RETENTION + retry.sweep);
    expect(await recorded(f, runId)).toBe(false);
    expect((await state(runId)).erased).toBe(true);
  });

  it("retires a run forgotten before a reset, even once its retention is raised", async () => {
    const { f, runId } = await completedRun();
    await at(runId, T0 + RETENTION);
    await configure(runId, (run) => {
      run.hooks.afterRepoCall = (op) => {
        if (op === "forgetRun") throw new Error("reset");
      };
    });
    await drain(runId);
    expect(await recorded(f, runId)).toBe(false);
    expect((await state(runId)).erased).toBe(false);
    // A deploy raises the retention before the retry: the run stays retiring, never revived
    // without its record.
    await inRun(runId, (run) => {
      delete run.hooks.afterRepoCall;
      run.policy = { ...run.policy, retentionMs: 100 * DAY };
    });
    expect(await runStub(runId).get()).toBeUndefined();
    expect(await runStub(runId).rerun("usr_x")).toEqual({ ok: false, code: "run_not_found" });
    await inRun(runId, async (run) => {
      const sweep = run.policy.sweepMs;
      (run.context as { now: () => number }).now = () => T0 + RETENTION + sweep;
      await run.alarm();
    });
    expect((await state(runId)).erased).toBe(true);
    expect(await recorded(f, runId)).toBe(false);
  });

  it("runs nothing else for the run while it retires, so no concurrency call follows the forget", async () => {
    const f = await repoWithCommit();
    const runId = await started(
      f,
      `name: ci\non: push\nconcurrency: deploy\njobs:\n${job("build")}`,
    );
    await configure(runId);
    await finish(runId, "build");
    const calls: string[] = [];
    await at(runId, T0 + RETENTION);
    await configure(runId, (run) => {
      run.hooks.beforeRepoCall = (op) => {
        calls.push(op);
        if (op === "forgetRun") throw new Error("the repository could not be reached");
      };
    });
    await drain(runId);
    expect(calls).toContain("forgetRun");
    // Its retirement began and waits to retry; then a scope still being given back comes due.
    calls.length = 0;
    await inRun(runId, (run) => {
      run.engine.exec("UPDATE run_owners SET state = 'releasing'");
      run.jobs.ensure("run_concurrency", RUN_JOB.concurrency, { runAt: T0 + RETENTION + 1 });
    });
    expect(
      await inRun(
        runId,
        (run) => run.engine.rows("SELECT 1 FROM run_owners WHERE state = 'releasing'").length,
      ),
    ).toBeGreaterThan(0);
    await at(runId, T0 + RETENTION + 1);
    await drain(runId);
    expect(calls).toEqual([]);
    expect((await state(runId)).erased).toBe(false);
  });

  it("stops every other job from the slice its retirement begins in, within one alarm", async () => {
    const f = await repoWithCommit();
    const runId = await started(
      f,
      `name: ci\non: push\nconcurrency: deploy\njobs:\n${job("build")}`,
    );
    await configure(runId);
    await finish(runId, "build");
    const calls: string[] = [];
    await inRun(runId, async (run) => {
      run.policy = { ...run.policy, retentionMs: RETENTION };
      // Due in the same alarm as the expiry's check, just after it: the check begins the
      // retirement, which fails, then the scope's job comes up.
      run.engine.exec("UPDATE run_owners SET state = 'releasing'");
      run.jobs.ensure("run_concurrency", RUN_JOB.concurrency, { runAt: T0 + RETENTION + 1 });
      run.hooks.beforeRepoCall = (op) => {
        calls.push(op);
        if (op === "forgetRun") throw new Error("the repository could not be reached");
      };
      (run.context as { now: () => number }).now = () => T0 + RETENTION + 1;
      await run.alarm();
    });
    expect(calls).toContain("forgetRun");
    expect(calls.some((op) => /Concurrency$/.test(op))).toBe(false);
  });

  it("retries a failing erasure past the job's attempt limit, then erases", async () => {
    const { f, runId } = await completedRun();
    await at(runId, T0 + RETENTION);
    await configure(runId, (run) => {
      (run as unknown as { erase: () => Promise<boolean> }).erase = async () => {
        throw new Error("storage unavailable");
      };
    });
    const sweep = await inRun(runId, (run) => run.policy.sweepMs);
    for (let i = 0; i < 12; i++) {
      await at(runId, T0 + RETENTION + i * sweep);
      await inRun(runId, async (run) => {
        run.policy = { ...run.policy, retentionMs: RETENTION };
        await run.alarm();
      });
    }
    expect(
      await inRun(runId, (run) =>
        run.engine.rows<{ state: string; attempts: number }>(
          "SELECT state, attempts FROM jobs WHERE job_id = ?",
          RUN_JOB.retire,
        ),
      ),
    ).toEqual([{ state: "queued", attempts: 0 }]);
    expect(await recorded(f, runId)).toBe(false);
    await configure(runId, (run) => {
      delete (run as unknown as { erase?: unknown }).erase;
    });
    await runAt(runId, T0 + RETENTION + 12 * sweep);
    expect((await state(runId)).erased).toBe(true);
  });

  it("counts each kind of work still owed when it retires the run anyway", async () => {
    const { runId } = await completedRun();
    const counted = await inRun(runId, async (run) => {
      run.policy = { ...run.policy, retentionMs: RETENTION };
      // A check update the repository never takes: its calls keep failing.
      run.engine.exec("UPDATE run_checks SET rev = rev + 1");
      run.hooks.beforeRepoCall = (op) => {
        if (op === "startCheckAttempts" || op === "recordCheckUpdates")
          throw new Error("the repository refuses check updates");
      };
      const metrics = run.context.metrics as { count: (...args: unknown[]) => void };
      const original = metrics.count;
      const seen: unknown[] = [];
      metrics.count = (...args: unknown[]) => {
        if (args[0] === "ci.run_retired_owed") seen.push(args[1]);
        return original.apply(metrics, args);
      };
      (run.context as { now: () => number }).now = () => T0 + RETENTION;
      try {
        await run.alarm();
      } finally {
        metrics.count = original;
      }
      return seen;
    });
    expect(counted).toEqual([{ owed: "checks" }]);
    expect((await state(runId)).erased).toBe(true);
  });

  it("counts dropped work once, when the run is erased, however often its erasure was retried", async () => {
    const { runId } = await completedRun();
    const seen: unknown[] = [];
    const alarmAt = (t: number, failErase: boolean) =>
      inRun(runId, async (run) => {
        run.policy = { ...run.policy, retentionMs: RETENTION };
        run.hooks.beforeRepoCall = (op) => {
          if (op === "startCheckAttempts" || op === "recordCheckUpdates")
            throw new Error("the repository refuses check updates");
        };
        const self = run as unknown as { erase?: () => Promise<boolean> };
        if (failErase)
          self.erase = async () => {
            throw new Error("storage unavailable");
          };
        else delete self.erase;
        const metrics = run.context.metrics as { count: (...args: unknown[]) => void };
        const original = metrics.count;
        metrics.count = (...args: unknown[]) => {
          if (args[0] === "ci.run_retired_owed") seen.push(args[1]);
          return original.apply(metrics, args);
        };
        (run.context as { now: () => number }).now = () => t;
        try {
          await run.alarm();
        } finally {
          metrics.count = original;
        }
      });
    await inRun(runId, (run) => run.engine.exec("UPDATE run_checks SET rev = rev + 1"));
    const sweep = await inRun(runId, (run) => run.policy.sweepMs);
    await alarmAt(T0 + RETENTION, true);
    await alarmAt(T0 + RETENTION + sweep, true);
    expect(seen).toEqual([]);
    await alarmAt(T0 + RETENTION + 2 * sweep, false);
    expect(seen).toEqual([{ owed: "checks" }]);
    expect((await state(runId)).erased).toBe(true);
  });

  it("erases the run as gone when its repository answers it deleted", async () => {
    const { runId } = await completedRun();
    await at(runId, T0 + RETENTION);
    await configure(runId, (run) => {
      run.hooks.beforeRepoCall = (op) => {
        if (op === "forgetRun") throw new Error("repo_not_found: deleted");
      };
    });
    await drain(runId);
    expect((await state(runId)).erased).toBe(true);
  });
});

describe("a trigger's start retried for a retiring run", () => {
  it("is refused as erased and leaves no record of the run", async () => {
    const f = await repoWithCommit();
    const spec = specFor(f, SOURCE);
    const owner = { owner: await ownerOf(f.repo.id) };
    await at(spec.runId, T0);
    expect((await startRun(env, spec, owner)).ok).toBe(true);
    await configure(spec.runId);
    await drain(spec.runId);
    await finish(spec.runId, "build");
    // Expired, not yet retired, and still recorded: the start is retried.
    await at(spec.runId, T0 + RETENTION);
    await configure(spec.runId);
    expect(await recorded(f, spec.runId)).toBe(true);
    const again: StartRunAnswer = await startRun(env, spec, owner);
    expect(again).toEqual({ ok: false, code: "run_erased" });
    expect(await recorded(f, spec.runId)).toBe(false);
    // Its repository forgot it: a deploy raising the retention before any alarm runs does not
    // bring it back.
    await inRun(spec.runId, (run) => {
      run.policy = { ...run.policy, retentionMs: 100 * DAY };
    });
    expect(await runStub(spec.runId).get()).toBeUndefined();
    expect(await runStub(spec.runId).rerun("usr_x")).toEqual({ ok: false, code: "run_not_found" });
  });
});

describe("the retirement seam", () => {
  it("retires as at a given time, and reports what is left", async () => {
    const { f, runId } = await completedRun();
    const before = await inRun(runId, (run) => run.ciReconcileAt(T0 + RETENTION - 1));
    expect(before).toMatchObject({ erased: false });
    expect(await recorded(f, runId)).toBe(true);
    const after = await inRun(runId, (run) => {
      run.policy = { ...run.policy, retentionMs: RETENTION };
      return run.ciReconcileAt(T0 + RETENTION);
    });
    expect(after).toEqual({ erased: true, jobs: [], alarm: null });
    expect(await recorded(f, runId)).toBe(false);
  });
});
