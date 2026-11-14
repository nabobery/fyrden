// Runs in concurrency groups end to end, through the run objects and the
// repository's registry: a second run waits pending until the first
// releases, a third displaces it, cancel-in-progress cancels the owner,
// matrix instances sharing a job-level group run one at a time, a job group
// equal to its workflow's own group fails as a deadlock, nothing starts on a
// grant that has lapsed here, and a scope cancelled while its request was in
// flight gives back what the answer granted.
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
  drain,
  expr,
  type Fixture,
  finish,
  inRun,
  job,
  jobNamed,
  jobsOf,
  repoWithCommit,
  runStub,
  specFor,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";

const grouped = (cancel = false) =>
  `name: ci\non: push\nconcurrency:\n  group: deploy\n  cancel-in-progress: ${cancel}\njobs:\n${job("a")}`;

/** Delivers the repository's due concurrency signals and runs what they wake in each run. */
async function settle(f: Fixture, runIds: string[]) {
  await inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) => r.alarm());
  for (const runId of runIds) await drain(runId);
}

describe("runs in one concurrency group", () => {
  it("keeps the second pending until the first releases, then starts it", async () => {
    const f = await repoWithCommit();
    const first = await started(f, grouped());
    expect(await runStub(first).get()).toMatchObject({ status: "in_progress" });
    const second = await started(f, grouped());
    expect(await runStub(second).get()).toMatchObject({ status: "pending" });
    expect(await jobsOf(second)).toEqual([]);
    await finish(first, "a");
    await settle(f, [first, second]);
    expect(await runStub(second).get()).toMatchObject({ status: "in_progress" });
    expect((await jobNamed(second, "a")).status).toBe("queued");
  });

  it("lets a third run displace the pending one, which ends cancelled without running", async () => {
    const f = await repoWithCommit();
    const first = await started(f, grouped());
    const second = await started(f, grouped());
    const third = await started(f, grouped());
    await settle(f, [first, second, third]);
    expect(await runStub(second).get()).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    expect(await runStub(third).get()).toMatchObject({ status: "pending" });
  });

  it("cancels the running owner on cancel-in-progress and starts the newcomer once it released", async () => {
    const f = await repoWithCommit();
    const first = await started(f, grouped());
    const second = await started(f, grouped(true));
    await settle(f, [first, second]);
    expect(await runStub(first).get()).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    await settle(f, [first, second]);
    expect(await runStub(second).get()).toMatchObject({ status: "in_progress" });
  });
});

describe("a promotion that comes with a cancel", () => {
  it("ends a run that never started instead of starting it", async () => {
    const f = await repoWithCommit();
    const always = `name: ci\non: push\nconcurrency: deploy\njobs:\n${job("a", ["if: always()"])}`;
    const first = await started(f, always);
    const second = await started(f, always);
    expect(await runStub(second).get()).toMatchObject({ status: "pending" });
    await finish(first, "a");
    // The repository promotes the second run; before it hears, a third asks to cancel it.
    const third = await started(
      f,
      `name: ci\non: push\nconcurrency:\n  group: deploy\n  cancel-in-progress: true\njobs:\n${job("a")}`,
    );
    await settle(f, [first, second, third]);
    await settle(f, [first, second, third]);
    expect(await runStub(second).get()).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    expect(await jobsOf(second)).toEqual([]);
  });
});

describe("job-level groups", () => {
  it("runs matrix instances that share a job group one at a time", async () => {
    const f = await repoWithCommit();
    const source = workflow(
      job("m", ["strategy:", "  matrix:", "    n: [1, 2]", "concurrency:", "  group: shared"]),
    );
    const runId = await started(f, source);
    await settle(f, [runId]);
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["queued", "blocked"]);
    await finish(runId, "m (1)");
    await settle(f, [runId]);
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["completed", "queued"]);
  });

  it("evaluates a job group per instance from its matrix", async () => {
    const f = await repoWithCommit();
    const source = workflow(
      job("m", [
        "strategy:",
        "  matrix:",
        "    n: [1, 2]",
        "concurrency:",
        `  group: g-${expr("matrix.n")}`,
      ]),
    );
    const runId = await started(f, source);
    await settle(f, [runId]);
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["queued", "queued"]);
  });

  it("queues a granted instance under max-parallel while another waits for its group", async () => {
    const f = await repoWithCommit();
    // Another run holds g-1.
    await env.REPO.getByName(f.repo.id).acquireConcurrency([
      {
        group: "g-1",
        runId: "01J0000000000000000000000X",
        ownerKey: "a1",
        cancelInProgress: false,
        holdMs: 0,
      },
    ]);
    const source = workflow(
      job("m", [
        "strategy:",
        "  max-parallel: 1",
        "  matrix:",
        "    n: [1, 2]",
        "concurrency:",
        `  group: g-${expr("matrix.n")}`,
      ]),
    );
    const runId = await started(f, source);
    await settle(f, [runId]);
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["blocked", "queued"]);
  });

  it("fails fast past an instance whose group does not evaluate, reaching later siblings", async () => {
    const f = await repoWithCommit();
    const source = workflow(
      job("m", [
        "strategy:",
        "  matrix:",
        '    g: ["", "valid"]',
        "concurrency:",
        `  group: ${expr("matrix.g")}`,
      ]),
    );
    const runId = await started(f, source);
    expect((await jobsOf(runId)).map((j) => [j.status, j.conclusion])).toEqual([
      ["completed", "failure"],
      ["completed", "cancelled"],
    ]);
  });

  it("reads strategy as expansion does: without a matrix, max-parallel is the total", async () => {
    const f = await repoWithCommit();
    const source = workflow(
      job("a", [
        `name: mp-${expr("strategy.max-parallel")}`,
        "strategy:",
        "  max-parallel: 3",
        "concurrency:",
        `  group: mp-${expr("strategy.max-parallel")}`,
      ]),
    );
    const runId = await started(f, source);
    const rows = await inRun(runId, (r) =>
      r.engine.rows<{ name: string; group_name: string }>(
        "SELECT name, group_name FROM run_instances",
      ),
    );
    expect(rows).toEqual([{ name: "mp-1", group_name: "mp-1" }]);
  });

  it("fails a job whose group is its workflow's own group, as a deadlock", async () => {
    const f = await repoWithCommit();
    const source = `name: ci\non: push\nconcurrency: Deploy\njobs:\n${job("a", ["concurrency: deploy"])}`;
    const runId = await started(f, source);
    await settle(f, [runId]);
    expect(await jobNamed(runId, "a")).toMatchObject({ conclusion: "failure" });
    expect((await jobNamed(runId, "a")).error).toMatch(/concurrency_deadlock/);
  });
});

describe("grants", () => {
  it("starts nothing once the grant lapsed here, until a renew confirms it", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, grouped());
    const a = await jobNamed(runId, "a");
    await inRun(runId, (r) => {
      r.engine.exec("UPDATE run_owners SET lease_valid_until = 0");
    });
    const refused = (await runStub(runId).assign(a.jobId, "k")) as AssignAnswer;
    expect(refused).toEqual({ ok: false, code: "not_queued" });
    await advance(runId, 3 * 60_000);
    const assigned = (await runStub(runId).assign(a.jobId, "k")) as AssignAnswer;
    expect(assigned.ok).toBe(true);
  });

  it("asks for no job group while the workflow's grant has lapsed here", async () => {
    const f = await repoWithCommit();
    const source = `name: ci\non: push\nconcurrency: deploy\njobs:\n${[job("a"), job("b", ["needs: a", "concurrency:", "  group: other", "  cancel-in-progress: true"])].join("\n")}`;
    const runId = await started(f, source);
    const task = await assignNamed(runId, "a");
    await inRun(runId, (r) => {
      r.engine.exec("UPDATE run_owners SET lease_valid_until = 0 WHERE owner_key = 'a1'");
      r.hooks = {
        beforeRepoCall: (op) => {
          if (op === "renewConcurrency") throw new Error("outage");
        },
      };
    });
    await runStub(runId).completeTask(task, { result: "success", logComplete: true });
    await drain(runId);
    expect((await jobNamed(runId, "b")).status).toBe("blocked");
    await advance(runId, 60_000);
    const group = await inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec("SELECT * FROM concurrency_groups WHERE group_key = 'other'")
        .toArray(),
    );
    expect(group).toEqual([]);
    await inRun(runId, (r) => {
      r.hooks = {};
    });
  });

  it("gives back a grant whose answer arrived after its run was cancelled", async () => {
    const f = await repoWithCommit();
    const spec = specFor(f, grouped());
    await at(spec.runId, T0);
    await inRun(spec.runId, (r) => {
      r.hooks = {
        afterRepoCall: async (op) => {
          if (op === "acquireConcurrency") r.cancel("usr_x", "force");
        },
      };
    });
    await startRun(env, spec);
    await drain(spec.runId);
    await inRun(spec.runId, (r) => {
      r.hooks = {};
    });
    await drain(spec.runId);
    expect(await runStub(spec.runId).get()).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    const group = await inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) =>
      r.git.context.storage.sql.exec("SELECT * FROM concurrency_groups").toArray(),
    );
    expect(group).toEqual([]);
    // A new run is admitted at once.
    const next = await started(f, grouped());
    expect(await runStub(next).get()).toMatchObject({ status: "in_progress" });
  });
});
