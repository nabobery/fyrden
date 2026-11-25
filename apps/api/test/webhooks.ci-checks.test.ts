import { beforeEach, describe, expect, it } from "vitest";
import { entityBody, webhookEventOf } from "../src/webhooks/events.js";
import { checkRunsOf, ciFixture } from "./helpers/ci-webhooks.js";
import {
  advance,
  assignNamed,
  expr,
  type Fixture,
  finish,
  job,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();
let f: Fixture;
const SOURCE = workflow(job("build"));

beforeEach(async () => {
  f = await ciFixture(t);
});

const sent = async () =>
  (await t.bodies(await t.routed())).map((b) => {
    const check = b.check_run as { name: string; status: string; conclusion: string | null };
    return [b.action, check.name, check.status, check.conclusion];
  });

describe("check run events", () => {
  it("are GitHub's created and completed", () => {
    expect(webhookEventOf("check_run.created")).toEqual({ event: "check_run", action: "created" });
    expect(webhookEventOf("check_run.completed")).toEqual({
      event: "check_run",
      action: "completed",
    });
    expect(webhookEventOf("check_run.rerequested")).toBeUndefined();
  });

  it("refuse a body not made from their capture", () => {
    expect(() =>
      entityBody({ event: "check_run", action: "created" }, { data: {} } as never),
    ).toThrow(/capture/);
  });

  it("carry the check as the API shows it, when it starts and when it completes", async () => {
    await t.createHook({ events: ["check_run"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    const [queued] = await checkRunsOf(f);
    await assignNamed(runId, "build");
    await advance(runId, 2_000);
    await finish(runId, "build", "failure");
    await advance(runId, 2_000);
    const [done] = await checkRunsOf(f);
    const events = await t.routed();
    const [created, completed, ...rest] = await t.bodies(events);
    expect(rest).toEqual([]);
    const user = { id: t.owner.principalId, login: t.owner.handle };
    expect(created).toEqual({
      fyrden_payload: 1,
      event: "check_run",
      action: "created",
      check_run: {
        ...queued,
        name: "build",
        head_sha: f.sha,
        status: "queued",
        conclusion: null,
        attempt: 1,
        run: { id: runId, run_attempt: 1, job_id: 1 },
        details_url: null,
        updated_at: new Date(queued?.updated_at as number).toISOString(),
      },
      repository: { id: t.repo.id, name: t.repo.name, owner: user, private: true },
      sender: { ...user, act_chain: [] },
      at: expect.any(String),
      position: expect.anything(),
    });
    expect(completed).toMatchObject({
      action: "completed",
      check_run: {
        ...done,
        conclusion: "failure",
        updated_at: new Date(done?.updated_at as number).toISOString(),
      },
      sender: user,
    });
  });

  it("are not sent for a check in progress, or for an update repeated", async () => {
    await t.createHook({ events: ["check_run"] });
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    await assignNamed(runId, "build");
    await advance(runId, 2_000);
    expect(await sent()).toEqual([["created", "build", "queued", null]]);
    await finish(runId, "build");
    await advance(runId, 2_000);
    const again = await t
      .stub()
      .recordCheckUpdates([
        { sha: f.sha, name: "build", attempt: 1, status: "completed", conclusion: "success" },
      ]);
    expect(again).toEqual(["unchanged"]);
    const start = await t
      .stub()
      .startCheckAttempts(f.sha, [
        { name: "build", startKey: `${runId}/a1/j1`, actor: t.owner.principalId },
      ]);
    expect(start).toEqual([{ ok: true, attempt: 1, current: true }]);
    expect(await sent()).toEqual([
      ["created", "build", "queued", null],
      ["completed", "build", "completed", "success"],
    ]);
  });

  it("are sent once for a check started and completed in one batch of the run's", async () => {
    await t.createHook({ events: ["check_run"] });
    const runId = await started(f, workflow(job("skipped", ["if: false"])));
    await advance(runId, 2_000);
    expect(await sent()).toEqual([
      ["created", "skipped", "queued", null],
      ["completed", "skipped", "completed", "skipped"],
    ]);
  });

  it("are sent for a workflow file that could not run, with no job", async () => {
    await t.createHook({ events: ["check_run"] });
    const runId = await started(f, "name: ci\non: push\njobs: {}\n");
    await advance(runId, 2_000);
    const bodies = await t.bodies(await t.routed());
    expect(bodies.map((b) => [b.action, (b.check_run as { run: unknown }).run])).toEqual([
      ["created", { id: runId, run_attempt: 1, job_id: null }],
      ["completed", { id: runId, run_attempt: 1, job_id: null }],
    ]);
  });

  it("are not completed for a check another run took over", async () => {
    await t.createHook({ events: ["check_run"] });
    const first = await started(f, SOURCE);
    await advance(first, 2_000);
    const second = await started(f, SOURCE);
    await advance(second, 2_000);
    await finish(first, "build");
    await advance(first, 2_000);
    await finish(second, "build", "failure");
    await advance(second, 2_000);
    const bodies = await t.bodies(await t.routed());
    expect(bodies.map((b) => [b.action, (b.check_run as { run: { id: string } }).run.id])).toEqual([
      ["created", first],
      ["created", second],
      ["completed", second],
    ]);
  });

  it("are sent for the re-run's attempt, and for a failing name it no longer produces", async () => {
    await t.createHook({ events: ["check_run"] });
    const runId = await started(
      f,
      workflow(
        [
          job("names", ["outputs:", "  list: x"]),
          job("m", [
            "needs: names",
            "strategy:",
            "  matrix:",
            `    n: ${expr("fromJSON(needs.names.outputs.list)")}`,
          ]),
        ].join("\n"),
      ),
    );
    await finish(runId, "names", "success", { list: '["a"]' });
    await finish(runId, "m (a)", "failure");
    await advance(runId, 2_000);
    expect((await runStub(runId).rerun(t.owner.principalId)).ok).toBe(true);
    await advance(runId, 0);
    await finish(runId, "names", "success", { list: '["b"]' });
    await finish(runId, "m (b)");
    await advance(runId, 2_000);
    const bodies = await t.bodies(await t.routed());
    const of = (name: string) =>
      bodies
        .map((b) => [b.action, b.check_run as Record<string, unknown>] as const)
        .filter(([, check]) => check.name === name)
        .map(([action, check]) => [action, check.attempt, check.conclusion]);
    expect(of("names")).toEqual([
      ["created", 1, null],
      ["completed", 1, "success"],
      ["created", 2, null],
      ["completed", 2, "success"],
    ]);
    expect(of("m (a)")).toEqual([
      ["created", 1, null],
      ["completed", 1, "failure"],
      ["created", 2, null],
      ["completed", 2, "cancelled"],
    ]);
    expect(of("m (b)")).toEqual([
      ["created", 1, null],
      ["completed", 1, "success"],
    ]);
  });

  it("go to no hook that does not take them, and write no event for it", async () => {
    await t.createHook({ events: ["push", "status"] });
    const before = (await t.outbox()).length;
    const runId = await started(f, SOURCE);
    await advance(runId, 2_000);
    await finish(runId, "build");
    await advance(runId, 2_000);
    expect(await t.outbox()).toHaveLength(before);
  });

  it("keep their text as data whatever a job is named", async () => {
    await t.createHook({ events: ["check_run"] });
    const name = `<script>"\\u0000"</script> \${{ x }}`;
    const answers = await t.stub().startCheckAttempts(f.sha, [{ name, startKey: "other/key" }]);
    expect(answers).toEqual([{ ok: true, attempt: 1, current: true }]);
    const [body] = await t.bodies(await t.routed());
    expect(body?.check_run).toMatchObject({ name, run: null });
    expect(body?.sender).toBeNull();
  });
});
