import { beforeEach, describe, expect, it } from "vitest";
import { ciVariableOverrides } from "../src/ci/budget.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { AssignAnswer, RunDO } from "../src/do/RunDO.js";
import type { JobReport, RunReport } from "../src/do/repo/run-history.js";
import { entityBody, webhookEventOf } from "../src/webhooks/events.js";
import { ciFixture } from "./helpers/ci-webhooks.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  assignNamed,
  drain,
  expr,
  type Fixture,
  finish,
  inRun,
  job,
  jobNamed,
  jobsOf,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();
let f: Fixture;
const SOURCE = workflow(job("build"));
const matrix = (n: number, extra: string[] = []) =>
  workflow(
    job("m", [
      "strategy:",
      ...extra,
      "  matrix:",
      `    n: [${Array.from({ length: n }, (_, i) => i + 1).join(", ")}]`,
    ]),
  );

beforeEach(async () => {
  f = await ciFixture(t);
});

const setHooks = (runId: string, hooks: RunDO["hooks"]) =>
  inRun(runId, (r) => {
    r.hooks = hooks;
  });
const failing = (op: string): RunDO["hooks"] => ({
  beforeRepoCall: (called) => {
    if (called === op) throw new Error("repository away");
  },
});
const reportOf = async (runId: string): Promise<RunReport> => {
  const report = await inRun(runId, (r) => r.runReport());
  if (!report) throw new Error("no report");
  return report;
};

const bodies = async (entity: "workflow_job" | "check_run" = "workflow_job") => {
  const events = (await t.routed()).filter((e) => e.type.startsWith(`${entity}.`));
  return events.length === 0 ? [] : t.bodies(events);
};
const sent = async (entity?: "workflow_job" | "check_run") =>
  (await bodies(entity)).map((b) => {
    const body = (b.workflow_job ?? b.check_run) as Record<string, unknown>;
    return [b.action, body.name, body.conclusion];
  });
const counts = async (entity: "workflow_job" | "check_run") => {
  const of: Record<string, number> = {};
  for (const e of await t.routed())
    if (e.type.startsWith(`${entity}.`)) {
      const action = e.type.slice(entity.length + 1);
      of[action] = (of[action] ?? 0) + 1;
    }
  return of;
};
const finishAll = async (runId: string) => {
  for (const j of (await runStub(runId).listJobs(undefined, 0, 256))?.jobs ?? []) {
    if (j.status !== "queued") continue;
    const answer = (await runStub(runId).assign(j.jobId, `k${j.jobId}`)) as AssignAnswer;
    if (answer.ok)
      await runStub(runId).completeTask(answer.task, { result: "success", logComplete: true });
  }
  await drain(runId);
};

describe("workflow job events", () => {
  it("are GitHub's queued, in_progress and completed", () => {
    for (const action of ["queued", "in_progress", "completed"])
      expect(webhookEventOf(`workflow_job.${action}`)).toEqual({ event: "workflow_job", action });
    expect(webhookEventOf("workflow_job.waiting")).toBeUndefined();
    expect(() =>
      entityBody({ event: "workflow_job", action: "queued" }, { data: {} } as never),
    ).toThrow(/capture/);
  });

  it("carry the job as the API shows it, and the run it is of", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, SOURCE, { github: { workflow: "CI" } });
    await advance(runId, 2_000);
    await assignNamed(runId, "build");
    await advance(runId, 2_000);
    await finish(runId, "build", "failure");
    await advance(runId, 2_000);
    const row = await jobNamed(runId, "build");
    const iso = (ms: number | null) => new Date(ms as number).toISOString();
    const [queued, running, done, ...rest] = await bodies();
    expect(rest).toEqual([]);
    const user = { id: t.owner.principalId, login: t.owner.handle };
    const fixed = {
      id: 1,
      run_id: runId,
      run_attempt: 1,
      workflow_name: "CI",
      head_branch: "main",
      head_sha: f.sha,
      name: "build",
      job_key: "build",
      labels: ["ubuntu-latest"],
    };
    expect(queued).toEqual({
      fyrden_payload: 1,
      event: "workflow_job",
      action: "queued",
      workflow_job: {
        ...fixed,
        status: "queued",
        conclusion: null,
        started_at: null,
        completed_at: null,
      },
      repository: { id: t.repo.id, name: t.repo.name, owner: user, private: true },
      sender: { ...user, act_chain: [] },
      at: expect.any(String),
      position: expect.anything(),
    });
    expect(running?.workflow_job).toEqual({
      ...fixed,
      status: "in_progress",
      conclusion: null,
      started_at: iso(row.startedAt),
      completed_at: null,
    });
    expect(done?.workflow_job).toEqual({
      ...fixed,
      status: "completed",
      conclusion: "failure",
      started_at: iso(row.startedAt),
      completed_at: iso(row.completedAt),
    });
  });

  it("are not queued until the job may take a runner", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, matrix(2, ["  max-parallel: 1"]));
    await advance(runId, 2_000);
    expect(await sent()).toEqual([["queued", "m (1)", null]]);
    await finish(runId, "m (1)");
    await advance(runId, 2_000);
    expect((await sent()).slice(1)).toEqual([
      ["completed", "m (1)", "success"],
      ["queued", "m (2)", null],
    ]);
  });

  it("are only completed for a job skipped, and for one that ended between two reports", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, workflow([job("a", ["if: false"]), job("b")].join("\n")));
    await finish(runId, "b");
    await advance(runId, 2_000);
    expect(await sent()).toEqual([
      ["completed", "a", "skipped"],
      ["completed", "b", "success"],
    ]);
  });

  it("conclude as the job did, where its check is neutral", async () => {
    await t.createHook({ events: ["workflow_job", "check_run"] });
    const runId = await started(f, workflow(job("a", ["continue-on-error: true"])));
    await finish(runId, "a", "failure");
    await advance(runId, 2_000);
    expect(await sent()).toEqual([["completed", "a", "failure"]]);
    expect((await sent("check_run")).at(-1)).toEqual(["completed", "a", "neutral"]);
  });

  it("are sent for jobs without a check: a name repeated, a name kept back", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(
      f,
      workflow(
        [
          job("x", ["name: Build"]),
          job("y", ["name: build"]),
          job("z", ["name: 'workflow file: z'"]),
        ].join("\n"),
      ),
    );
    await advance(runId, 2_000);
    const codes = (await jobsOf(runId)).map((j) => j.check.code);
    expect(codes).toEqual([null, "duplicate_check", "reserved_name"]);
    for (const name of ["Build", "build"]) await finish(runId, name);
    await advance(runId, 2_000);
    expect((await sent()).filter(([action]) => action === "completed")).toEqual([
      ["completed", "workflow file: z", "failure"],
      ["completed", "Build", "success"],
      ["completed", "build", "success"],
    ]);
  });

  it("are sent when only a job without a check moves", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(
      f,
      workflow([job("x", ["name: Build"]), job("y", ["name: build"])].join("\n")),
    );
    await advance(runId, 2_000);
    await finish(runId, "build");
    await advance(runId, 2_000);
    expect((await sent()).at(-1)).toEqual(["completed", "build", "success"]);
  });

  it("are completed for a job whose check another run took over", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const first = await started(f, SOURCE);
    await advance(first, 2_000);
    const second = await started(f, SOURCE);
    await advance(second, 2_000);
    await finish(first, "build", "failure");
    await advance(first, 2_000);
    expect((await sent()).at(-1)).toEqual(["completed", "build", "failure"]);
  });

  it("are not repeated for a job taken back from a runner that never got it", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    const task = await assignNamed(runId, "build");
    await advance(runId, 2_000);
    expect(await inRun(runId, (r) => r.requeueTask(task))).toBe(true);
    await advance(runId, 2_000);
    expect((await jobNamed(runId, "build")).status).toBe("queued");
    await assignNamed(runId, "build", "again");
    await advance(runId, 2_000);
    expect((await runStub(runId).cancel(t.owner.principalId, "force")).ok).toBe(true);
    await advance(runId, 2_000);
    expect(await sent()).toEqual([
      ["queued", "build", null],
      ["in_progress", "build", null],
      ["completed", "build", "cancelled"],
    ]);
  });

  it("come before the end of their run", async () => {
    await t.createHook({ events: ["workflow_job", "workflow_run"] });
    const runId = await started(f, matrix(2));
    await advance(runId, 2_000);
    expect((await runStub(runId).cancel(t.owner.principalId, "force")).ok).toBe(true);
    await advance(runId, 2_000);
    expect((await t.routed()).map((e) => e.type).slice(-3)).toEqual([
      "workflow_job.completed",
      "workflow_job.completed",
      "workflow_run.completed",
    ]);
  });

  it("are sent to a hook made during the run, from the job's next move on", async () => {
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    await t.createHook({ events: ["workflow_job"] });
    await assignNamed(runId, "build");
    await advance(runId, 2_000);
    expect(await sent()).toEqual([["in_progress", "build", null]]);
  });

  it("write no event when no hook takes them", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    await finish(runId, "build");
    await advance(runId, 2_000);
    const types = (await t.outbox()).map((e) => e.type);
    expect(types.filter((type) => type.startsWith("workflow_job."))).toEqual([]);
  });

  it("carry a job's labels, unless another job's outputs could be in them", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const on = (text: string, runsOn: string) =>
      text.replace("runs-on: ubuntu-latest", `runs-on: ${runsOn}`);
    const runId = await started(
      f,
      workflow(
        [
          job("a", ["outputs:", "  os: x"]),
          job("b", ["needs: a"]),
          on(job("c", ["needs: a"]), expr("needs.a.outputs.os")),
          on(
            job("d", ["strategy:", "  matrix:", "    os: [left, right]"]),
            `[self-hosted, "${expr("matrix.os")}"]`,
          ),
          job("e", ["if: false"]),
        ].join("\n"),
      ),
    );
    await finish(runId, "a", "success", { os: "s3cret-label" });
    await advance(runId, 2_000);
    const made = await bodies();
    const labels = made.map((b) => {
      const row = b.workflow_job as { name: string; labels: string[] | null };
      return [row.name, row.labels] as const;
    });
    expect(Object.fromEntries(labels)).toEqual({
      a: ["ubuntu-latest"],
      b: ["ubuntu-latest"],
      c: null,
      "d (left)": ["self-hosted", "left"],
      "d (right)": ["self-hosted", "right"],
      e: null,
    });
    expect(JSON.stringify(made)).not.toContain("s3cret-label");
  });

  it("carry no labels of a workflow that no longer plans", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, SOURCE);
    await inRun(runId, (r) => r.engine.exec("UPDATE runs SET workflow_source = 'on: push'"));
    await advance(runId, 2_000);
    expect((await bodies()).map((b) => b.workflow_job)).toMatchObject([
      { name: "build", labels: null },
    ]);
  });

  it("are reported with the workflow read once, whether or not it plans", async () => {
    const runId = await started(f, matrix(30));
    const reads = (source?: string) =>
      inRun(runId, (r) => {
        if (source) r.engine.exec("UPDATE runs SET workflow_source = ?", source);
        const run = r.engine.run.bind(r.engine);
        let read = 0;
        r.engine.run = () => {
          read++;
          return run();
        };
        const jobs = r.jobReports();
        r.engine.run = run;
        return { read, jobs: jobs.length };
      });
    expect(await reads()).toEqual({ read: 1, jobs: 30 });
    expect(await reads("on: push")).toEqual({ read: 1, jobs: 30 });
  });

  it("are sent of a job whose id, and so its name, is longer than any text carried", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const id = `j${"x".repeat(3_000)}`;
    const withExplicitKey = workflow(job(id)).replace(`  ${id}:`, `  ? ${id}\n  :`);
    const runId = await started(f, withExplicitKey);
    await advance(runId, 2_000);
    const [body] = await bodies();
    expect(body?.workflow_job).toMatchObject({
      name: id.slice(0, 256),
      job_key: id.slice(0, 256),
      status: "queued",
    });
  });

  it("cannot carry a name longer or stranger than the API's", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const name = `a\u0007b${"é".repeat(400)}`;
    const runId = await started(f, workflow(job("x", [`name: ${JSON.stringify(name)}`])));
    await advance(runId, 2_000);
    const [body] = await bodies();
    const shown = (body as { workflow_job: { name: string } }).workflow_job.name;
    expect([...shown]).toHaveLength(256);
    expect(shown.startsWith("a�bé")).toBe(true);
  });
});

describe("job reports", () => {
  it("are not told again after an eviction, and write nothing then", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, SOURCE);
    await assignNamed(runId, "build");
    await advance(runId, 2_000);
    const before = await toldOf(runId);
    await inRun(runId, (r) => {
      r.forgetReported();
      r.jobs.ensure("run_checks", "checks");
    });
    await drain(runId);
    expect(await toldOf(runId)).toBe(before);
    expect(await sent()).toEqual([["in_progress", "build", null]]);
  });

  it("are sent again when their answer is lost, and told once", async () => {
    await t.createHook({ events: ["workflow_job", "workflow_run"] });
    const runId = await started(f, SOURCE);
    let lost = 0;
    await setHooks(runId, {
      afterRepoCall: (op) => {
        if (op === "reportRun" && lost++ < 2) throw new Error("answer lost");
      },
    });
    await advance(runId, 2_000);
    await advance(runId, 60_000);
    await advance(runId, 60_000);
    expect(lost).toBe(3);
    expect((await t.routed()).map((e) => e.type)).toEqual([
      "workflow_run.requested",
      "workflow_run.in_progress",
      "workflow_job.queued",
    ]);
  });

  it("that land after later ones tell nothing", async () => {
    await t.createHook({ events: ["workflow_job", "workflow_run"] });
    const runId = await started(f, SOURCE);
    const early = await reportOf(runId);
    const jobs = await inRun(runId, (r) => r.jobReports());
    expect(jobs.map((j) => j.action)).toEqual(["queued"]);
    await advance(runId, 2_000);
    await finish(runId, "build");
    await advance(runId, 2_000);
    const before = (await t.routed()).length;
    expect(await t.stub().reportRun(early, { jobs })).toMatchObject({ ok: true, jobsDone: 1 });
    expect(await t.routed()).toHaveLength(before);
  });

  it("whose answers come back in another order acknowledge no less", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, matrix(2));
    await advance(runId, 2_000);
    const task = await assignNamed(runId, "m (2)");
    let nested = false;
    await setHooks(runId, {
      afterRepoCall: async (op) => {
        if (op !== "reportRun" || nested) return;
        nested = true;
        await runStub(runId).completeTask(task, { result: "success", logComplete: true });
        await advance(runId, 61_000);
      },
    });
    await advance(runId, 2_000);
    expect(nested).toBe(true);
    await setHooks(runId, {});
    expect(await inRun(runId, (r) => r.jobReports())).toEqual([]);
    expect(await sent()).toEqual([
      ["queued", "m (1)", null],
      ["queued", "m (2)", null],
      ["in_progress", "m (2)", null],
      ["completed", "m (2)", "success"],
    ]);
  });

  it("of a job without a check that moves during a report are sent next", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(
      f,
      workflow([job("x", ["name: Build"]), job("y", ["name: build"])].join("\n")),
    );
    let moved = false;
    await setHooks(runId, {
      afterRepoCall: async (op) => {
        if (op !== "reportRun" || moved) return;
        moved = true;
        await assignNamed(runId, "build");
      },
    });
    await advance(runId, 2_000);
    await advance(runId, 2_000);
    expect((await sent()).at(-1)).toEqual(["in_progress", "build", null]);
  });

  it("owed over several attempts are all sent, a bounded number at a time", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, matrix(150));
    await setHooks(runId, failing("reportRun"));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await finishAll(runId);
      if (attempt < 3) {
        expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
        await drain(runId);
      }
    }
    const sizes: number[] = [];
    await setHooks(runId, {
      beforeRepoCall: async (op) => {
        if (op === "reportRun") sizes.push((await inRunJobs(runId)).length);
      },
    });
    await advance(runId, 3_600_000);
    for (let i = 0; i < 3; i++) await advance(runId, 2_000);
    expect(sizes.slice(0, 2)).toEqual([256, 194]);
    expect(await counts("workflow_job")).toEqual({ completed: 450 });
    const ids = (await t.routed()).map((e) => e.data?.webhook as { tree: Record<string, unknown> });
    const seen = new Set(ids.map((w) => (w.tree.workflow_job as { id: number }).id));
    expect(seen.size).toBe(450);
  });

  it("go on past jobs a repository without the run could not be told, and send them once it has it", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, matrix(200));
    await inRepo(t.stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("DELETE FROM ci_runs WHERE run_id = ?", runId),
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
      await finishAll(runId);
      await advance(runId, 2_000);
      await advance(runId, 2_000);
      expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
      await drain(runId);
    }
    expect(await t.routed()).toEqual([]);
    const state = await reportOf(runId);
    const path = ".github/workflows/ci.yml";
    expect(await t.stub().registerRun({ runId, sha: f.sha, path, state })).toMatchObject({
      ok: true,
      jobsDone: 0,
    });
    await advance(runId, 2_000);
    for (let page = 0; page < 3; page++) await advance(runId, 2_000);
    expect(await counts("workflow_job")).toEqual({ queued: 200, completed: 600 });
  });

  it("are sent again past what a restored repository was told, by a run that knew more", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, matrix(3));
    await finish(runId, "m (1)");
    await advance(runId, 2_000);
    const backup = await toldOf(runId);
    await finish(runId, "m (2)");
    await finish(runId, "m (3)");
    await advance(runId, 2_000);
    expect((await counts("workflow_job")).completed).toBe(3);
    await inRepo(t.stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("UPDATE ci_runs SET told = ? WHERE run_id = ?", backup, runId),
    );
    await advance(runId, 7 * 24 * 60 * 60_000);
    await advance(runId, 2_000);
    const ended = (await bodies())
      .filter((b) => b.action === "completed")
      .map((b) => (b.workflow_job as { name: string }).name);
    expect(ended).toEqual(["m (1)", "m (2)", "m (3)", "m (2)", "m (3)"]);
    expect(await inRun(runId, (r) => r.jobReports())).toEqual([]);
  });

  it("are sent again to a repository restored from before a job's end past one still running", async () => {
    await t.createHook({ events: ["workflow_job"] });
    const runId = await started(f, matrix(2));
    await assignNamed(runId, "m (1)");
    await advance(runId, 2_000);
    const backup = await toldOf(runId);
    await finish(runId, "m (2)");
    await advance(runId, 2_000);
    await inRepo(t.stub(), (r: RepoDO) => {
      const { sql } = r.git.context.storage;
      sql.exec("UPDATE ci_runs SET told = ? WHERE run_id = ?", backup, runId);
      sql.exec("UPDATE repo_meta SET epoch_gen = epoch_gen + 1 WHERE id = 1");
    });
    await inRun(runId, (r) => r.ciReconcileAt(r.context.now()));
    await advance(runId, 2_000);
    expect((await jobNamed(runId, "m (1)")).status).toBe("in_progress");
    await inRepo(t.stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("UPDATE ci_runs SET told = ? WHERE run_id = ?", backup, runId),
    );
    await inRun(runId, (r) => r.forgetReported());
    await inRun(runId, (r) => r.ciReconcileAt(r.context.now()));
    await advance(runId, 2_000);
    const ended = (await t.routed())
      .filter((e) => e.type === "workflow_job.completed")
      .map((e) => {
        const { webhook } = e.data as { webhook: { tree: { workflow_job: { name: string } } } };
        const { tree } = webhook;
        return `${e.id.epochGen}:${tree.workflow_job.name}`;
      });
    expect(ended).toEqual(["1:m (2)", "2:m (2)", "2:m (2)"]);
  });

  it("are refused when they are not ones", async () => {
    const runId = await started(f, SOURCE);
    const report = await reportOf(runId);
    const [good] = await inRun(runId, (r) => r.jobReports());
    if (!good) throw new Error("no job");
    const bad: Partial<Record<keyof JobReport, unknown>>[] = [
      { jobId: 0 },
      { jobId: 1.5 },
      { attempt: 2 },
      { action: "blocked" },
      { action: "completed", conclusion: null },
      { conclusion: "success" },
      { conclusion: "stale", action: "completed" },
      { name: "" },
      { name: "x".repeat(3_000) },
      { key: "" },
      { triggeringActor: "" },
      { labels: [""] },
      { labels: Array.from({ length: 101 }, () => "x") },
    ];
    for (const change of bad)
      await expect(
        inRepo(t.stub(), (r: RepoDO) =>
          r.reportRun(report, { jobs: [{ ...good, ...change } as JobReport] }),
        ),
        JSON.stringify(change),
      ).rejects.toThrow("invalid run report");
    await expect(
      inRepo(t.stub(), (r: RepoDO) =>
        r.reportRun(report, {
          jobs: Array.from({ length: 257 }, (_, i) => ({ ...good, jobId: i + 1 })),
        }),
      ),
    ).rejects.toThrow("invalid run report");
  });
});

describe("a matrix larger than the Free plan tells job by job", () => {
  beforeEach(() => {
    ciVariableOverrides.FYRDEN_PLAN = "free";
  });

  it("sends 32 in-between events of each kind, and every end", async () => {
    await t.createHook({ events: ["workflow_job", "check_run", "workflow_run"] });
    const runId = await started(f, matrix(40));
    await advance(runId, 2_000);
    expect(await counts("check_run")).toEqual({ created: 32 });
    expect(await counts("workflow_job")).toEqual({ queued: 32 });
    expect((await runStub(runId).cancel(t.owner.principalId, "force")).ok).toBe(true);
    await advance(runId, 2_000);
    expect(await counts("check_run")).toEqual({ created: 32, completed: 40 });
    expect(await counts("workflow_job")).toEqual({ queued: 32, completed: 40 });
    expect((await t.routed()).filter((e) => e.type.startsWith("workflow_run."))).toHaveLength(3);
  });

  it("counts over an attempt's batches, and only what a hook took", async () => {
    const runId = await started(f, SOURCE);
    const report = await reportOf(runId);
    const [first] = await inRun(runId, (r) => r.jobReports());
    if (!first) throw new Error("no job");
    const batch = async (from: number) => {
      const ids = Array.from({ length: 20 }, (_, i) => from + i);
      await t.stub().startCheckAttempts(
        f.sha,
        ids.map((id) => ({ name: `j${id}`, startKey: `${runId}/a1/j${id}` })),
      );
      await t.stub().reportRun(report, { jobs: ids.map((jobId) => ({ ...first, jobId })) });
    };
    await batch(1);
    await batch(21);
    await t.createHook({ events: ["workflow_job", "check_run"] });
    await batch(41);
    await batch(61);
    expect(await counts("workflow_job")).toEqual({ queued: 32 });
    expect(await counts("check_run")).toEqual({ created: 32 });
  });

  it("sends no in-between event of an attempt once a later one had any", async () => {
    await t.createHook({ events: ["workflow_job", "check_run"] });
    const runId = await started(f, SOURCE);
    const report = { ...(await reportOf(runId)), attempt: 2 };
    const [first] = await inRun(runId, (r) => r.jobReports());
    if (!first) throw new Error("no job");
    const start = (id: number, attempt: number) =>
      t
        .stub()
        .startCheckAttempts(f.sha, [{ name: `j${id}`, startKey: `${runId}/a${attempt}/j${id}` }]);
    await start(1, 1);
    await t.stub().reportRun(report, { jobs: [{ ...first, jobId: 2, attempt: 2 }] });
    await start(3, 1);
    await start(4, 2);
    expect(await sent("check_run")).toEqual([
      ["created", "j1", null],
      ["created", "j4", null],
    ]);
  });

  it("sends no in-between event of a run the repository does not hold", async () => {
    await t.createHook({ events: ["check_run"] });
    const runId = await started(f, SOURCE);
    await inRepo(t.stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("DELETE FROM ci_runs WHERE run_id = ?", runId),
    );
    await t.stub().startCheckAttempts(f.sha, [{ name: "late", startKey: `${runId}/a1/j9` }]);
    expect(await counts("check_run")).toEqual({});
  });

  it("counts afresh for a re-run", async () => {
    const runId = await started(f, matrix(33));
    await advance(runId, 2_000);
    await t.createHook({ events: ["workflow_job", "check_run"] });
    expect((await runStub(runId).cancel(t.owner.principalId, "force")).ok).toBe(true);
    await advance(runId, 2_000);
    for (let attempt = 2; attempt <= 3; attempt++) {
      expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
      await drain(runId);
      await advance(runId, 2_000);
      expect(await counts("workflow_job")).toMatchObject({ queued: 32 * (attempt - 1) });
      expect(await counts("check_run")).toMatchObject({ created: 32 * (attempt - 1) });
      expect((await runStub(runId).cancel(t.owner.principalId, "force")).ok).toBe(true);
      await advance(runId, 2_000);
    }
    expect(await counts("workflow_job")).toEqual({ queued: 64, completed: 99 });
  });

  it("sends every one on Paid", async () => {
    ciVariableOverrides.FYRDEN_PLAN = "paid";
    await t.createHook({ events: ["workflow_job", "check_run"] });
    const runId = await started(f, matrix(40));
    await advance(runId, 2_000);
    expect(await counts("check_run")).toEqual({ created: 40 });
    expect(await counts("workflow_job")).toEqual({ queued: 40 });
  });
});

const toldOf = (runId: string) =>
  inRepo(
    t.stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ told: string | null }>("SELECT told FROM ci_runs WHERE run_id = ?", runId)
        .toArray()[0]?.told,
  );
const inRunJobs = (runId: string) => inRun(runId, (r) => r.jobReports());
