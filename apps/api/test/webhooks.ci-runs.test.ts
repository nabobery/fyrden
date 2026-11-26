import { beforeEach, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { RunDO } from "../src/do/RunDO.js";
import type { RunReport } from "../src/do/repo/run-history.js";
import { entityBody, webhookEventOf } from "../src/webhooks/events.js";
import { api, json } from "./helpers/api.js";
import { ciFixture } from "./helpers/ci-webhooks.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  at,
  drain,
  type Fixture,
  finish,
  inRun,
  job,
  now,
  runStub,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();
let f: Fixture;
const SOURCE = workflow(job("build"));
const DAY = 24 * 60 * 60_000;

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
const sql = <T>(work: (exec: RepoDO["git"]["context"]["storage"]["sql"]) => T) =>
  inRepo(t.stub(), (r: RepoDO) => work(r.git.context.storage.sql));
const toldOf = (runId: string) =>
  sql(
    (s) =>
      s
        .exec<{ told: string | null }>("SELECT told FROM ci_runs WHERE run_id = ?", runId)
        .toArray()[0]?.told,
  );

const sent = async () => {
  const events = await t.routed();
  if (events.length === 0) return [];
  return (await t.bodies(events)).map((b) => {
    const run = b.workflow_run as Record<string, unknown>;
    return [b.action, run.run_attempt, run.status, run.conclusion];
  });
};

const heldSpec = {
  event: "pull_request",
  ref: "refs/pull/1/head",
  trust: "untrusted" as const,
  fork: true,
  approval: { workflowBlob: "b".repeat(40), action: "opened" },
  github: { head_ref: "topic", event: { pull_request: { number: 1, title: "Topic" } } },
};

describe("workflow run events", () => {
  it("are GitHub's requested, in_progress and completed", () => {
    for (const action of ["requested", "in_progress", "completed"])
      expect(webhookEventOf(`workflow_run.${action}`)).toEqual({ event: "workflow_run", action });
    expect(webhookEventOf("workflow_run.queued")).toBeUndefined();
    expect(() =>
      entityBody({ event: "workflow_run", action: "requested" }, { data: {} } as never),
    ).toThrow(/capture/);
  });

  it("carry the run as the API lists it", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE, { github: { workflow: "CI", run_number: "4" } });
    await advance(runId, 2_000);
    await finish(runId, "build", "failure");
    await advance(runId, 2_000);
    const listed = await json<{ workflow_runs: Record<string, unknown>[] }>(
      api("GET", `${t.path}/actions/runs`, t.owner.token),
    );
    const [run] = listed.body.workflow_runs;
    const iso = (key: string) => new Date(run?.[key] as number).toISOString();
    const events = await t.routed();
    const bodies = await t.bodies(events);
    expect(bodies.map((b) => b.action)).toEqual(["requested", "in_progress", "completed"]);
    const user = { id: t.owner.principalId, login: t.owner.handle };
    expect(bodies[2]).toEqual({
      fyrden_payload: 1,
      event: "workflow_run",
      action: "completed",
      workflow_run: {
        ...run,
        id: runId,
        run_number: 4,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        pull_request: null,
        actor: user,
        triggering_actor: user,
        created_at: iso("created_at"),
        updated_at: iso("updated_at"),
        run_started_at: iso("run_started_at"),
        completed_at: iso("completed_at"),
      },
      repository: { id: t.repo.id, name: t.repo.name, owner: user, private: true },
      sender: { ...user, act_chain: [] },
      at: expect.any(String),
      position: { epoch: events[2]?.id.epochGen, sequence: events[2]?.id.sourceSeq },
    });
  });

  it("are not sent again for a report repeated after an eviction, or landing late", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    const early = await reportOf(runId);
    await advance(runId, 2_000);
    await inRun(runId, (r) => r.forgetReported());
    await finish(runId, "build");
    await advance(runId, 2_000);
    await t.stub().reportRun(early);
    await t.stub().reportRun(await reportOf(runId));
    expect((await sent()).map(([action]) => action)).toEqual([
      "requested",
      "in_progress",
      "completed",
    ]);
  });

  it("are not requested again for a re-run, which its own actor sends", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    await finish(runId, "build", "failure");
    await advance(runId, 2_000);
    expect((await runStub(runId).rerun("usr_rerunner")).ok).toBe(true);
    await drain(runId);
    await finish(runId, "build");
    await advance(runId, 2_000);
    expect(await sent()).toEqual([
      ["requested", 1, "completed", "failure"],
      ["completed", 1, "completed", "failure"],
      ["completed", 2, "completed", "success"],
    ]);
    const [last] = (await t.bodies(await t.routed())).slice(-1);
    expect(last?.sender).toEqual({ id: "usr_rerunner", login: "ghost", act_chain: [] });
  });

  it("tell an attempt's end when its re-run begins before it was reported", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    await finish(runId, "build", "failure");
    expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
    await drain(runId);
    await advance(runId, 2_000);
    expect(await sent()).toEqual([
      ["requested", 1, "in_progress", null],
      ["in_progress", 1, "in_progress", null],
      ["completed", 1, "completed", "failure"],
      ["in_progress", 2, "in_progress", null],
    ]);
  });

  it("tell every attempt that ended while the repository could not be told", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    await setHooks(runId, failing("reportRun"));
    for (const result of ["failure", "cancelled"] as const) {
      await finish(runId, "build", result);
      await advance(runId, 2_000);
      expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
      await drain(runId);
    }
    expect(await t.routed()).toEqual([]);
    await setHooks(runId, {});
    await advance(runId, 3_600_000);
    expect(await sent()).toEqual([
      ["requested", 1, "completed", "failure"],
      ["completed", 1, "completed", "failure"],
      ["completed", 2, "completed", "cancelled"],
      ["in_progress", 3, "in_progress", null],
    ]);
  });

  it("are sent for a run cancelled while it waits for its group, and for one that cannot run", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const source = `concurrency: deploy\n${SOURCE}`;
    const holder = await started(f, source);
    await advance(holder, 2_000);
    const waiting = await started(f, source);
    await advance(waiting, 2_000);
    expect((await runStub(waiting).cancel(t.owner.principalId, "graceful")).ok).toBe(true);
    await advance(waiting, 2_000);
    const broken = await started(f, "name: ci\non: push\njobs: {}\n");
    await advance(broken, 2_000);
    expect((await sent()).slice(2)).toEqual([
      ["requested", 1, "pending", null],
      ["completed", 1, "completed", "cancelled"],
      ["requested", 1, "completed", "failure"],
      ["completed", 1, "completed", "failure"],
    ]);
  });

  it("only request a held run, until it is approved, then follow it to its one end", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE, heldSpec);
    await advance(runId, 2_000);
    expect(await sent()).toEqual([["requested", 1, "completed", "action_required"]]);
    const binding = await inRun(
      runId,
      (r) =>
        r.engine.rows<{ binding: string }>("SELECT binding FROM run_approval")[0]?.binding ?? "",
    );
    expect(await runStub(runId).approve(binding, t.owner.principalId)).toEqual({ ok: true });
    await advance(runId, 2_000);
    expect((await runStub(runId).cancel(t.owner.principalId, "force")).ok).toBe(true);
    await advance(runId, 2_000);
    expect((await sent()).slice(1)).toEqual([
      ["in_progress", 1, "in_progress", null],
      ["completed", 1, "completed", "cancelled"],
    ]);
    const [body] = await t.bodies((await t.routed()).slice(0, 1));
    expect(body?.workflow_run).toMatchObject({
      fork: true,
      head_branch: "topic",
      pull_request: { number: 1 },
      completed_at: null,
    });
  });

  it("complete a held run that a newer one supersedes", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE, heldSpec);
    await advance(runId, 2_000);
    expect(await runStub(runId).supersede()).toEqual({ ok: true });
    await advance(runId, 2_000);
    expect((await sent()).slice(1)).toEqual([["completed", 1, "completed", "cancelled"]]);
  });

  it("wait for a transfer to end", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    const transfer = { transferId: "tr_1", from: t.owner.principalId, to: "usr_other" };
    expect(await inRepo(t.stub(), (r: RepoDO) => r.events.freezeForTransfer(transfer))).toBe(
      "frozen",
    );
    await advance(runId, 2_000);
    await inRepo(t.stub(), (r: RepoDO) => r.events.unfreezeTransfer("tr_1"));
    expect(await t.routed()).toEqual([]);
    await advance(runId, 3_600_000);
    expect((await sent()).map(([action]) => action)).toEqual(["requested", "in_progress"]);
  });

  it("are not sent for a report that lands after the run was forgotten", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    const late = await reportOf(runId);
    expect(await t.stub().forgetRun({ runId })).toEqual({ ok: true });
    expect(await t.stub().reportRun(late)).toMatchObject({ ok: true, recorded: false });
    expect(await t.routed()).toEqual([]);
  });

  it("tell what the weekly check recorded, when the run next reports", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    const state = await reportOf(runId);
    const registration = { runId, sha: f.sha, path: ".github/workflows/ci.yml", state };
    expect(await t.stub().registerRun(registration)).toMatchObject({ ok: true, jobsDone: 0 });
    expect(await t.routed()).toEqual([]);
    await advance(runId, 2_000);
    expect((await sent()).map(([action]) => action)).toEqual(["requested", "in_progress"]);
  });

  it("tell again what a restore lost of a run it removed, once the weekly check registers it", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    await sql((s) => s.exec("DELETE FROM ci_runs WHERE run_id = ?", runId));
    await finish(runId, "build");
    await advance(runId, 2_000);
    expect((await sent()).map(([action]) => action)).toEqual(["requested", "in_progress"]);
    await inRun(runId, (r) => r.ciReconcileAt(r.context.now()));
    await advance(runId, 2_000);
    expect(await sent()).toEqual([
      ["requested", 1, "in_progress", null],
      ["in_progress", 1, "in_progress", null],
      ["requested", 1, "completed", "success"],
      ["completed", 1, "completed", "success"],
    ]);
  });

  it("tell again what a restore lost of a run it kept, ended attempts too", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    const columns = "state_seq, status, conclusion, completed_at, summary, told";
    const backup = await sql(
      (s) =>
        s
          .exec<Record<string, SqlStorageValue>>(
            `SELECT ${columns} FROM ci_runs WHERE run_id = ?`,
            runId,
          )
          .toArray()[0],
    );
    if (!backup) throw new Error("no record");
    await finish(runId, "build", "failure");
    await advance(runId, 2_000);
    expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
    await drain(runId);
    await advance(runId, 2_000);
    await sql((s) => {
      s.exec(
        `UPDATE ci_runs SET (${columns}) = (?, ?, ?, ?, ?, ?) WHERE run_id = ?`,
        ...Object.values(backup),
        runId,
      );
      s.exec("UPDATE repo_meta SET epoch_gen = epoch_gen + 1 WHERE id = 1");
    });
    await inRun(runId, (r) => r.ciReconcileAt(r.context.now()));
    await advance(runId, 2_000);
    const told = (await t.routed()).map((e) => {
      const { webhook } = e.data as {
        webhook: { tree: { action: string; workflow_run: { run_attempt: number } } };
      };
      return `${e.id.epochGen}:${webhook.tree.action}:${webhook.tree.workflow_run.run_attempt}`;
    });
    expect(told).toEqual([
      "1:requested:1",
      "1:in_progress:1",
      "1:completed:1",
      "1:in_progress:2",
      "2:completed:1",
      "2:in_progress:2",
    ]);
  });

  it("tell again what a restore lost of a run it kept, when the run reports before its weekly check", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    const columns = "state_seq, status, conclusion, completed_at, summary, told";
    const backup = await sql(
      (s) =>
        s
          .exec<Record<string, SqlStorageValue>>(
            `SELECT ${columns} FROM ci_runs WHERE run_id = ?`,
            runId,
          )
          .toArray()[0],
    );
    if (!backup) throw new Error("no record");
    await finish(runId, "build", "failure");
    await advance(runId, 2_000);
    expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
    await drain(runId);
    await advance(runId, 2_000);
    await sql((s) => {
      s.exec(
        `UPDATE ci_runs SET (${columns}) = (?, ?, ?, ?, ?, ?) WHERE run_id = ?`,
        ...Object.values(backup),
        runId,
      );
      s.exec("UPDATE repo_meta SET epoch_gen = epoch_gen + 1 WHERE id = 1");
    });
    await finish(runId, "build");
    await advance(runId, 2_000);
    const told = (await t.routed()).map((e) => {
      const { webhook } = e.data as {
        webhook: { tree: { action: string; workflow_run: { run_attempt: number } } };
      };
      return `${e.id.epochGen}:${webhook.tree.action}:${webhook.tree.workflow_run.run_attempt}`;
    });
    expect(told).toEqual([
      "1:requested:1",
      "1:in_progress:1",
      "1:completed:1",
      "1:in_progress:2",
      "2:completed:1",
      "2:completed:2",
    ]);
  });

  it("tell only what follows of a run recorded before hooks were told of runs", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    await setHooks(runId, failing("reportRun"));
    const report = await reportOf(runId);
    await sql((s) =>
      s.exec(
        `UPDATE ci_runs SET state_seq = 140, status = 'in_progress', event = 'push', actor_id = ?,
           summary = ? WHERE run_id = ?`,
        report.actor,
        JSON.stringify(report),
        runId,
      ),
    );
    expect(await toldOf(runId)).toBeNull();
    await setHooks(runId, {});
    await finish(runId, "build");
    await advance(runId, 3_600_000);
    expect(await sent()).toEqual([["completed", 1, "completed", "success"]]);
  });

  it("read what an earlier shape of the record kept", async () => {
    await t.createHook({ events: ["workflow_run", "workflow_job"] });
    const runId = await started(f, SOURCE);
    await sql((s) =>
      s.exec("UPDATE ci_runs SET told = ? WHERE run_id = ?", '{"stateSeq":120}', runId),
    );
    await advance(runId, 2_000);
    expect((await t.routed()).map((e) => e.type)).toEqual([
      "workflow_run.in_progress",
      "workflow_job.queued",
    ]);
  });

  it("go to no hook that does not take them, and write no event for it", async () => {
    await t.createHook({ events: ["check_run"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    const types = (await t.outbox()).map((e) => e.type);
    expect(types).toContain("check_run.created");
    expect(types.filter((type) => type.startsWith("workflow_run."))).toEqual([]);
  });

  it("arm the object's alarm, so a report alone is delivered", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    const report = await reportOf(runId);
    const alarm = await inRepo(t.stub(), async (r: RepoDO) => {
      const { storage } = (r as unknown as { ctx: DurableObjectState }).ctx;
      await r.outbox.drain(t.repo.id);
      await storage.deleteAlarm();
      await r.reportRun(report);
      return storage.getAlarm();
    });
    expect(alarm).not.toBeNull();
  });

  it("are told once more as a run retires whose reports failed until then", async () => {
    await t.createHook({ events: ["workflow_run"] });
    const runId = await started(f, SOURCE);
    const retention = 8 * DAY;
    await inRun(runId, (r) => {
      r.policy = { ...r.policy, retentionMs: retention };
      r.hooks = failing("reportRun");
    });
    await finish(runId, "build");
    await advance(runId, 2_000);
    expect(await t.routed()).toEqual([]);
    await at(runId, T0 + retention + 3_000);
    await inRun(runId, (r) => {
      r.policy = { ...r.policy, retentionMs: retention };
      r.hooks = {};
      r.jobs.ensure("run_retire", "retire", { runAt: now(runId) });
    });
    await inRun(runId, (r) => r.ciReconcileAt(now(runId)));
    expect(await runStub(runId).get()).toBeUndefined();
    expect((await sent()).map(([action]) => action)).toEqual(["requested", "completed"]);
  });

  it("are sent of every job and attempt still owed as a run retires, however many", async () => {
    await t.createHook({ events: ["workflow_job", "workflow_run"] });
    const n = Array.from({ length: 150 }, (_, i) => i).join(", ");
    const source = workflow(job("m", ["strategy:", "  matrix:", `    n: [${n}]`]));
    const runId = await started(f, source);
    const retention = 8 * DAY;
    const configure = (hooks: RunDO["hooks"]) =>
      inRun(runId, (r) => {
        r.policy = { ...r.policy, retentionMs: retention };
        r.hooks = hooks;
      });
    await configure(failing("reportRun"));
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await runStub(runId).cancel(t.owner.principalId, "force")).ok).toBe(true);
      await drain(runId);
      if (attempt < 3) expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
      await drain(runId);
    }
    await advance(runId, 2_000);
    await at(runId, T0 + retention + 3_000);
    await configure({});
    await inRun(runId, (r) => r.ciReconcileAt(now(runId)));
    expect(await runStub(runId).get()).toBeUndefined();
    const types = (await t.routed()).map((e) => e.type);
    expect(types.filter((type) => type === "workflow_job.completed")).toHaveLength(450);
    expect(types.filter((type) => type === "workflow_run.completed")).toHaveLength(3);
  });

  it("refuse a report whose earlier attempts are not ones", async () => {
    const runId = await started(f, SOURCE);
    const report = { ...(await reportOf(runId)), attempt: 2 };
    const end = {
      attempt: 1,
      conclusion: "success" as const,
      triggeringActor: "usr_a",
      startedAt: 1,
      completedAt: 2,
    };
    for (const earlier of [
      [{ ...end, attempt: 2 }],
      [{ ...end, attempt: 0 }],
      [{ ...end, conclusion: "maybe" as never }],
      [{ ...end, triggeringActor: "" }],
      [{ ...end, completedAt: Number.NaN }],
      [end, end],
      Array.from({ length: 60 }, () => end),
    ])
      await expect(
        inRepo(t.stub(), (r: RepoDO) => r.reportRun(report, { earlier })),
      ).rejects.toThrow("invalid run report");
  });
});
