// A run's jobs as checks in the repository: one per instance, sent in
// batches (a 200-instance storm costs two repository calls, and one for the run), a duplicate
// name published once, a failure allowed by continue-on-error neutral, an
// update landing during a send sent next, a stale send never parking
// current work, and a re-run settling the failing checks it no longer
// produces while leaving another run's newer check alone.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { startRun } from "../src/ci/runs.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { AssignAnswer } from "../src/do/RunDO.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  assignNamed,
  at,
  checksOf,
  drain,
  expr,
  type Fixture,
  finish,
  inRun,
  job,
  jobNamed,
  jobsOf,
  ownerOf,
  repoWithCommit,
  runStub,
  specFor,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function countRepoCalls(runId: string, work: () => Promise<unknown>) {
  const calls: string[] = [];
  await inRun(runId, (r) => {
    r.hooks = { beforeRepoCall: (op) => void calls.push(op) };
  });
  try {
    await work();
  } finally {
    await inRun(runId, (r) => {
      r.hooks = {};
    });
  }
  return calls;
}

describe("matrix jobs", () => {
  it("keeps max-parallel instances live, a cancelling one holding its slot", async () => {
    const f = await repoWithCommit();
    const source = workflow(
      job("m", [
        "timeout-minutes: 5",
        "strategy:",
        "  fail-fast: false",
        "  max-parallel: 1",
        "  matrix:",
        "    n: [1, 2]",
      ]),
    );
    const runId = await started(f, source);
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["queued", "blocked"]);
    await assignNamed(runId, "m (1)");
    await advance(runId, 5 * MIN);
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["cancelling", "blocked"]);
    await advance(runId, 2 * MIN);
    expect((await jobsOf(runId)).map((j) => [j.status, j.conclusion])).toEqual([
      ["completed", "timed_out"],
      ["queued", null],
    ]);
  });

  it("fails fast: one instance failing cancels the others", async () => {
    const f = await repoWithCommit();
    const runId = await started(
      f,
      workflow(job("m", ["strategy:", "  matrix:", "    n: [1, 2, 3]"])),
    );
    const running = await assignNamed(runId, "m (2)");
    await finish(runId, "m (1)", "failure");
    expect((await jobsOf(runId)).map((j) => [j.name, j.status, j.conclusion])).toEqual([
      ["m (1)", "completed", "failure"],
      ["m (2)", "cancelling", null],
      ["m (3)", "completed", "cancelled"],
    ]);
    expect(await runStub(runId).updateTask(running)).toEqual({ ok: true, cancel: true });
  });

  it("publishes a failure allowed by continue-on-error as neutral and passes the run", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a", ["continue-on-error: true"])));
    await finish(runId, "a", "failure");
    await advance(runId, 2_000);
    expect((await checksOf(f)).get("a")?.conclusion).toBe("neutral");
    expect(await runStub(runId).get()).toMatchObject({ conclusion: "success" });
  });

  it("publishes one check for two instances whose names fold equal", async () => {
    const f = await repoWithCommit();
    const runId = await started(
      f,
      workflow([job("x", ["name: Build"]), job("y", ["name: build"])].join("\n")),
    );
    await advance(runId, 2_000);
    const jobs = await jobsOf(runId);
    expect(jobs.map((j) => j.check.code)).toEqual([null, "duplicate_check"]);
    expect([...(await checksOf(f)).keys()]).toEqual(["Build"]);
  });

  it("fails an instance whose outputs are too large and keeps them out of its dependents", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a", ["outputs:", "  big: x"])));
    const task = await assignNamed(runId, "a");
    const answer = await runStub(runId).completeTask(task, {
      result: "success",
      outputs: { big: "x".repeat(1024 * 1024) },
      logComplete: true,
    });
    expect(answer).toEqual({ ok: true, conclusion: "failure" });
    expect((await jobNamed(runId, "a")).error).toMatch(/outputs_too_large/);
  });
});

describe("check batches", () => {
  it("sends a 200-instance storm in one start call, one update call and one report of the run", async () => {
    const f = await repoWithCommit();
    const values = Array.from({ length: 200 }, (_, i) => i).join(", ");
    const runId = await started(
      f,
      workflow(job("m", ["strategy:", "  matrix:", `    n: [${values}]`])),
    );
    const calls = await countRepoCalls(runId, async () => {
      for (const j of (await runStub(runId).listJobs(undefined, 0, 256))?.jobs ?? []) {
        const answer = (await runStub(runId).assign(j.jobId, `k${j.jobId}`)) as AssignAnswer;
        if (answer.ok)
          await runStub(runId).completeTask(answer.task, { result: "success", logComplete: true });
      }
      await drain(runId);
      await advance(runId, 2_000);
    });
    expect(calls).toEqual(["startCheckAttempts", "recordCheckUpdates", "reportRun"]);
    const checks = await checksOf(f);
    expect(checks.size).toBe(200);
    expect([...checks.values()].every((c) => c.conclusion === "success")).toBe(true);
  });

  it("sends a completion that landed while an update was in flight", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    await advance(runId, 2_000);
    const task = await assignNamed(runId, "a");
    let completed = false;
    await inRun(runId, (r) => {
      r.hooks = {
        beforeRepoCall: async (op) => {
          if (op === "recordCheckUpdates" && !completed) {
            completed = true;
            await r.completeTask(task, { result: "failure", logComplete: true });
          }
        },
      };
    });
    await advance(runId, 2_000);
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    await advance(runId, 2_000);
    expect((await checksOf(f)).get("a")).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });

  it("does not let a taken-over send park current work", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    await advance(runId, 2_000);
    // The first send acknowledged `queued`; the next one sends `in_progress` and loses its claim
    // (another run of the job took it over) before it records the answer.
    await assignNamed(runId, "a");
    await inRun(runId, async (r) => {
      r.hooks = {
        afterRepoCall: () => {
          r.engine.exec("UPDATE jobs SET claim = claim + 1 WHERE kind = 'run_checks'");
        },
      };
    });
    await advance(runId, 2_000);
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    // The taken-over slice recorded nothing: the first send's acknowledgement stays, nothing parked.
    expect(
      await inRun(runId, (r) => r.engine.rows("SELECT parked, sent_rev, rev FROM run_checks")),
    ).toEqual([{ parked: null, sent_rev: 1, rev: 2 }]);
    // The next send, once the stale slice's lease ends, delivers the current state.
    await advance(runId, 61_000);
    expect((await checksOf(f)).get("a")?.status).toBe("in_progress");
    // And it was the retry: the current revision is acknowledged, nothing parked.
    expect(
      await inRun(runId, (r) => r.engine.rows("SELECT parked, sent_rev, rev FROM run_checks")),
    ).toEqual([{ parked: null, sent_rev: 2, rev: 2 }]);
  });
});

const dynamic = workflow(
  [
    job("define", ["outputs:", `  list: ${expr("steps.s.outputs.list")}`]),
    job("build", [
      "needs: define",
      `name: build ${expr("matrix.os")}`,
      "strategy:",
      "  fail-fast: false",
      "  matrix:",
      `    os: ${expr("fromJSON(needs.define.outputs.list)")}`,
    ]),
  ].join("\n"),
);

describe("re-runs and their checks", () => {
  it("settles a failing check the re-run no longer produces as cancelled, and leaves passes alone", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, dynamic);
    await finish(runId, "define", "success", { list: '["linux","windows","mac"]' });
    await finish(runId, "build linux");
    await finish(runId, "build windows", "failure");
    await finish(runId, "build mac");
    await advance(runId, 2_000);
    await runStub(runId).rerun(f.owner.principalId);
    await drain(runId);
    await finish(runId, "define", "success", { list: '["linux"]' });
    await finish(runId, "build linux");
    await advance(runId, 2_000);
    const checks = await checksOf(f);
    expect(checks.get("build windows")?.conclusion).toBe("cancelled");
    expect(checks.get("build mac")?.conclusion).toBe("success");
    expect(checks.get("build linux")?.conclusion).toBe("success");
  });

  it("leaves a check another run started meanwhile", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, dynamic);
    await finish(runId, "define", "success", { list: '["linux","windows"]' });
    await finish(runId, "build linux");
    await finish(runId, "build windows", "failure");
    await advance(runId, 2_000);
    // Another run starts "build windows" on the same commit.
    const [other] = await env.REPO.getByName(f.repo.id).startCheckAttempts(f.sha, [
      { name: "build windows", startKey: "other-run/a1/j1" },
    ]);
    expect(other).toMatchObject({ ok: true, current: true });
    await runStub(runId).rerun(f.owner.principalId);
    await drain(runId);
    await finish(runId, "define", "success", { list: '["linux"]' });
    await finish(runId, "build linux");
    await advance(runId, 2_000);
    expect((await checksOf(f)).get("build windows")).toMatchObject({
      status: "queued",
      attempt: 2,
    });
  });
});

describe("a re-run before the first flush", () => {
  it("sends the earlier attempt's start of a name before the re-run's, and publishes the re-run", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    await finish(runId, "a", "failure");
    // No flush yet: both attempts' checks of "a" are unsent.
    expect(await runStub(runId).rerun(f.owner.principalId)).toEqual({ ok: true, attempt: 2 });
    await drain(runId);
    await finish(runId, "a", "success");
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    expect((await checksOf(f)).get("a")).toMatchObject({ attempt: 2, conclusion: "success" });
    const parked = await inRun(runId, (r) =>
      r.engine.rows<{ parked: string | null }>(
        "SELECT parked FROM run_checks WHERE parked IS NOT NULL",
      ),
    );
    expect(parked).toEqual([]);
  });
});

describe("the check-start guard in the repository", () => {
  it("starts a superseding attempt only over the key it names, and a retry gets its own attempt", async () => {
    const f = await repoWithCommit();
    const repo = env.REPO.getByName(f.repo.id);
    await repo.startCheckAttempts(f.sha, [{ name: "c", startKey: "r/a1/j1" }]);
    expect(
      await repo.startCheckAttempts(f.sha, [
        { name: "c", startKey: "r/a2/x1", supersedes: "nope" },
      ]),
    ).toEqual([{ ok: false, code: "stale_attempt" }]);
    const first = await repo.startCheckAttempts(f.sha, [
      { name: "c", startKey: "r/a2/x1", supersedes: "r/a1/j1" },
    ]);
    expect(first).toEqual([{ ok: true, attempt: 2, current: true }]);
    // The answer was lost; the retry names the same keys after its own start made the old one stale.
    expect(
      await repo.startCheckAttempts(f.sha, [
        { name: "c", startKey: "r/a2/x1", supersedes: "r/a1/j1" },
      ]),
    ).toEqual([{ ok: true, attempt: 2, current: true }]);
    const rows = await inRepo(repo, (r: RepoDO) => r.checks.summariesOn(f.sha));
    expect(rows).toHaveLength(1);
  });

  it("refuses an update whose start key does not hold the attempt it names", async () => {
    const f = await repoWithCommit();
    const repo = env.REPO.getByName(f.repo.id);
    await repo.startCheckAttempts(f.sha, [{ name: "c", startKey: "other/a1/j1" }]);
    const update = { sha: f.sha, name: "c", attempt: 1, status: "completed" as const };
    expect(
      await repo.recordCheckUpdates([
        { ...update, startKey: "mine/a1/j1", conclusion: "failure" },
        { ...update, startKey: "other/a1/j1", status: "in_progress" },
      ]),
    ).toEqual(["unknown_attempt", "applied"]);
    expect((await checksOf(f)).get("c")).toMatchObject({ status: "in_progress", attempt: 1 });
  });
});

describe("checks after a restore of the repository", () => {
  type Rows = Record<string, SqlStorageValue>[];
  interface Backup {
    readonly summaries: Rows;
    readonly attempts: Rows;
    readonly runs: Rows;
  }

  const backupOf = (f: Fixture) =>
    inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO): Backup => {
      const { sql } = r.git.context.storage;
      return {
        summaries: sql.exec("SELECT * FROM check_summaries WHERE sha = ?", f.sha).toArray(),
        attempts: sql.exec("SELECT * FROM check_attempts WHERE sha = ?", f.sha).toArray(),
        runs: sql.exec("SELECT * FROM ci_runs").toArray(),
      };
    });

  const restore = (f: Fixture, backup: Backup) =>
    inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) => {
      const { sql } = r.git.context.storage;
      const put = (table: string, rows: Rows) => {
        for (const row of rows) {
          const columns = Object.keys(row);
          sql.exec(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            ...Object.values(row),
          );
        }
      };
      sql.exec("DELETE FROM check_summaries WHERE sha = ?", f.sha);
      sql.exec("DELETE FROM check_attempts WHERE sha = ?", f.sha);
      sql.exec("DELETE FROM ci_runs");
      put("check_summaries", backup.summaries);
      put("check_attempts", backup.attempts);
      put("ci_runs", backup.runs);
      sql.exec("UPDATE repo_meta SET epoch_gen = epoch_gen + 1 WHERE id = 1");
    });

  const parked = (runId: string) =>
    inRun(runId, (r) =>
      r.engine.rows<{ name: string; parked: string }>(
        "SELECT name, parked FROM run_checks WHERE parked IS NOT NULL",
      ),
    );

  const weeklyCheck = async (runId: string) => {
    await inRun(runId, async (r) => {
      r.forgetReported();
      await r.ciReconcileAt(r.context.now());
    });
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
  };

  it("starts a check again whose start the restore lost, and completes it", async () => {
    const f = await repoWithCommit();
    const backup = await backupOf(f);
    const runId = await started(f, workflow(job("a")));
    await advance(runId, 2_000);
    expect((await checksOf(f)).get("a")?.status).toBe("queued");
    await restore(f, backup);
    await finish(runId, "a");
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    expect((await checksOf(f)).get("a")).toMatchObject({
      status: "completed",
      conclusion: "success",
      attempt: 1,
    });
    expect(await parked(runId)).toEqual([]);
  });

  it("completes again, at the finished run's weekly check, a check whose end the restore lost, after each restore", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    const task = await assignNamed(runId, "a");
    await advance(runId, 2_000);
    const backup = await backupOf(f);
    expect((await checksOf(f)).get("a")?.status).toBe("in_progress");
    const done = await runStub(runId).completeTask(task, { result: "success", logComplete: true });
    expect(done.ok).toBe(true);
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    expect((await checksOf(f)).get("a")?.conclusion).toBe("success");
    for (let restores = 0; restores < 2; restores++) {
      await restore(f, backup);
      expect((await checksOf(f)).get("a")?.status).toBe("in_progress");
      await weeklyCheck(runId);
      expect((await checksOf(f)).get("a")).toMatchObject({
        status: "completed",
        conclusion: "success",
      });
    }
    expect(await parked(runId)).toEqual([]);
  });

  it("starts the checks of a finished run whose record the restore removed again at its weekly check", async () => {
    const f = await repoWithCommit();
    const backup = await backupOf(f);
    const runId = await started(f, workflow(job("a")));
    await finish(runId, "a", "failure");
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    await restore(f, backup);
    expect(await checksOf(f)).toEqual(new Map());
    await weeklyCheck(runId);
    expect((await checksOf(f)).get("a")).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });

  it("starts a re-run's check again after the earlier attempt's, so the re-run's stays current", async () => {
    const f = await repoWithCommit();
    const backup = await backupOf(f);
    const runId = await started(f, workflow(job("a")));
    await finish(runId, "a", "failure");
    await advance(runId, 2_000);
    expect((await runStub(runId).rerun(f.owner.principalId)).ok).toBe(true);
    await drain(runId);
    await finish(runId, "a", "success");
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    expect((await checksOf(f)).get("a")).toMatchObject({ attempt: 2, conclusion: "success" });
    await restore(f, backup);
    await weeklyCheck(runId);
    expect((await checksOf(f)).get("a")).toMatchObject({
      attempt: 2,
      status: "completed",
      conclusion: "success",
    });
    expect(await parked(runId)).toEqual([]);
  });

  it("settles again an earlier failing check the re-run no longer produces", async () => {
    const f = await repoWithCommit();
    const backup = await backupOf(f);
    const runId = await started(f, dynamic);
    await finish(runId, "define", "success", { list: '["linux","windows"]' });
    await finish(runId, "build linux");
    await finish(runId, "build windows", "failure");
    await advance(runId, 2_000);
    await runStub(runId).rerun(f.owner.principalId);
    await drain(runId);
    await finish(runId, "define", "success", { list: '["linux"]' });
    await finish(runId, "build linux");
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    expect((await checksOf(f)).get("build windows")?.conclusion).toBe("cancelled");
    await restore(f, backup);
    await weeklyCheck(runId);
    const checks = await checksOf(f);
    expect(checks.get("build windows")).toMatchObject({ attempt: 2, conclusion: "cancelled" });
    expect(checks.get("build linux")).toMatchObject({ attempt: 2, conclusion: "success" });
    expect(await parked(runId)).toEqual([]);
  });

  it("sends again an end the repository took just before a restore took it back", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    const task = await assignNamed(runId, "a");
    await advance(runId, 2_000);
    const backup = await backupOf(f);
    let restored = false;
    await inRun(runId, (r) => {
      r.hooks = {
        afterRepoCall: async (op) => {
          if (op !== "recordCheckUpdates" || restored) return;
          restored = true;
          await restore(f, backup);
        },
      };
    });
    await runStub(runId).completeTask(task, { result: "success", logComplete: true });
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    expect(restored).toBe(true);
    expect((await checksOf(f)).get("a")).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  });

  it("completes again the check of a run from before restore generations were kept", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    const task = await assignNamed(runId, "a");
    await advance(runId, 2_000);
    const backup = await backupOf(f);
    await runStub(runId).completeTask(task, { result: "success", logComplete: true });
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    await inRun(runId, (r) => r.engine.exec("UPDATE runs SET repo_epoch = 0"));
    await restore(f, backup);
    await weeklyCheck(runId);
    expect((await checksOf(f)).get("a")?.conclusion).toBe("success");
  });

  it("sends a check the restore took back before its run retires", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    const task = await assignNamed(runId, "a");
    await advance(runId, 2_000);
    const backup = await backupOf(f);
    await runStub(runId).completeTask(task, { result: "success", logComplete: true });
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    await restore(f, backup);
    await at(runId, T0 + 8 * DAY);
    await inRun(runId, (r) => {
      r.policy = { ...r.policy, retentionMs: DAY };
    });
    await drain(runId);
    expect(await runStub(runId).get()).toBeUndefined();
    expect((await checksOf(f)).get("a")?.conclusion).toBe("success");
  });

  it.each([
    ["recorded at its registration", true],
    ["not given to its creation", false],
  ])(
    "sends again a check acknowledged before the run's first report was answered, when a restore came between (epoch %s)",
    async (_, given) => {
      const f = await repoWithCommit();
      const spec = specFor(f, workflow(job("a")));
      const runId = spec.runId;
      await at(runId, T0);
      let backup: Backup | undefined;
      let reportsLost = true;
      await inRun(runId, (r) => {
        r.hooks = {
          beforeRepoCall: async (op) => {
            if (op === "startCheckAttempts" && !backup) backup = await backupOf(f);
            if (op === "reportRun" && reportsLost) throw new Error("answer lost");
          },
        };
      });
      const owner = await ownerOf(f.repo.id);
      if (given) expect((await startRun(env, spec, { owner })).ok).toBe(true);
      else {
        expect((await runStub(runId).reserve(spec)).ok).toBe(true);
        const repo = env.REPO.getByName(f.repo.id);
        expect(
          (await repo.registerRun({ runId, sha: spec.sha, path: spec.workflow.path })).ok,
        ).toBe(true);
        expect((await runStub(runId).create(spec, owner)).ok).toBe(true);
      }
      await drain(runId);
      await finish(runId, "a");
      for (let i = 0; i < 3; i++) await advance(runId, 2_000);
      expect((await checksOf(f)).get("a")?.conclusion).toBe("success");
      await restore(f, backup as Backup);
      expect((await checksOf(f)).get("a")).toBeUndefined();
      reportsLost = false;
      for (let i = 0; i < 3; i++) await advance(runId, 2_000);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
      expect((await checksOf(f)).get("a")).toMatchObject({
        status: "completed",
        conclusion: "success",
      });
    },
  );

  it("sends a re-run's check after the earlier attempt's when its retirement first sees the restore", async () => {
    const f = await repoWithCommit();
    const backup = await backupOf(f);
    const runId = await started(f, workflow(job("a")));
    await finish(runId, "a", "failure");
    await advance(runId, 2_000);
    expect((await runStub(runId).rerun(f.owner.principalId)).ok).toBe(true);
    await drain(runId);
    await finish(runId, "a", "success");
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    expect((await checksOf(f)).get("a")).toMatchObject({ attempt: 2, conclusion: "success" });
    await restore(f, backup);
    await at(runId, T0 + 8 * DAY);
    await inRun(runId, (r) => {
      r.policy = { ...r.policy, retentionMs: DAY };
    });
    for (let i = 0; i < 5; i++) await advance(runId, 2_000);
    expect(await runStub(runId).get()).toBeUndefined();
    expect((await checksOf(f)).get("a")).toMatchObject({
      attempt: 2,
      status: "completed",
      conclusion: "success",
    });
  });
});
