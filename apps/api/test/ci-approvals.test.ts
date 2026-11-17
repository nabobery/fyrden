// Fork runs from first-time contributors wait for a maintainer's approval:
// the run is created held (queued inside, shown as completed /
// action_required, no concurrency, no checks), writers get one
// approval_requested item on the pull request, a writer's approval starts
// it, a newer event's run supersedes an older waiting one (by the order of
// their events), and a held run that is cancelled or expires is settled in
// the repository. Every clock and alarm here is explicit.
import { env } from "cloudflare:workers";
import type { DomainEvent, FeedBlock } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordedAccount } from "../src/accounts/grants.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { CI_APPROVALS_JOB } from "../src/do/repo/run-approvals.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import {
  type CiRepo,
  ciRepo,
  commit,
  eventRunsOf,
  runTriggers,
  switchCi,
  viewOf,
  workflowFile,
} from "./helpers/ci-triggers.js";
import { inRepo } from "./helpers/repo-git.js";
import { at, drain, inRun, jobsOf, runStub } from "./helpers/runs.js";

const CI = ".github/workflows/ci.yml";
const DAY = 24 * 60 * 60_000;

beforeAll(() => switchCi(true));
afterAll(() => switchCi(false));

interface Held {
  readonly base: CiRepo;
  readonly writer: Who;
  readonly contributor: Who;
  readonly fork: { id: string; name: string; path: string };
  readonly number: number;
}

/**
 * A base repository with a `pull_request` workflow (`source`), a writer,
 * and a reader who opens a pull request from their fork.
 */
async function forkPull(
  source = workflowFile("pull_request"),
  permission: "pull" | "push" = "pull",
  more: Record<string, string> = {},
): Promise<Held> {
  const base = await ciRepo({ [CI]: source, "a.txt": "one\n", ...more });
  await runTriggers(base.stub);
  const writer = await user();
  const contributor = await user();
  for (const [who, role] of [
    [writer, "push"],
    [contributor, permission],
  ] as const)
    expect(
      (
        await api("PUT", `${base.path}/collaborators/${who.handle}`, base.owner.token, {
          permission: role,
        })
      ).status,
    ).toBe(200);
  const forked = await json<{ id: string; name: string }>(
    api("POST", `${base.path}/forks`, contributor.token, { name: uniqueId("fork") }),
  );
  expect(forked.status).toBe(201);
  const fork = { ...forked.body, path: `/repos/${contributor.handle}/${forked.body.name}` };
  await commit({ path: fork.path, owner: contributor }, "main", { "b.txt": "fork\n" });
  const opened = await json<{ number: number }>(
    api("POST", `${base.path}/pulls`, contributor.token, {
      title: "From a fork",
      head: `${contributor.handle}:main`,
      base: "main",
    }),
  );
  expect(opened.status).toBe(201);
  return { base, writer, contributor, fork, number: opened.body.number };
}

/** The pull_request runs the base allocated, oldest event first. */
const pullRuns = async (h: Held) =>
  (await eventRunsOf(h.base.stub)).filter((r) => r.trigger_kind === "pull_request");

/** Triggers the base's pending events and returns the newest pull_request run. */
async function newestRun(h: Held): Promise<string> {
  await runTriggers(h.base.stub);
  const runs = await pullRuns(h);
  const last = runs.at(-1);
  if (!last) throw new Error("no pull_request run");
  return last.run_id;
}

/** A push to the fork's branch, followed into the base as a pull request synchronize. */
async function synchronize(h: Held, files: Record<string, string>) {
  await commit({ path: h.fork.path, owner: h.contributor }, "main", files);
  // The base tells the fork what to follow, the fork tells it of pushes, the base imports them.
  for (const id of [h.base.repo.id, h.fork.id, h.base.repo.id])
    for (let i = 0; i < 3; i++) await inRepo(env.REPO.getByName(id), (r: RepoDO) => r.alarm());
}

/** Runs the repository's approval deliveries now. */
const deliver = (h: Held) =>
  inRepo(h.base.stub, (r: RepoDO) =>
    r.git.jobs.runJob(
      CI_APPROVALS_JOB,
      r.ciApprovals.handler(),
      r.git.memory,
      r.git.context.now() + 60_000,
    ),
  );

/** The run object's due work, at `offset` past the run's creation. */
async function runAt(runId: string, offset: number) {
  const view = await viewOf(runId);
  await at(runId, view.createdAt + offset);
  await drain(runId);
}

const approve = (h: Held, runId: string, who: Who | string) =>
  json<Record<string, unknown>>(
    api(
      "POST",
      `${h.base.path}/actions/runs/${runId}/approve`,
      typeof who === "string" ? who : who.token,
      {},
    ),
  );

const approvalRow = (h: Held, runId: string) =>
  inRepo(h.base.stub, (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ state: string; decided_by: string | null }>(
        "SELECT state, decided_by FROM ci_approvals WHERE run_id = ?",
        runId,
      )
      .toArray()
      .map((row) => ({ ...row })),
  );

/** The approval_requested entries of the base's feed blocks, oldest first, as `principal:state`. */
async function approvalItems(h: Held): Promise<string[][]> {
  const events = await inRepo(h.base.stub, (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
      .toArray()
      .map((row) => JSON.parse(row.event) as DomainEvent),
  );
  return events
    .filter((e) =>
      (e.feed as FeedBlock | undefined)?.audience.some((a) => a.kind === "approval_requested"),
    )
    .map((e) =>
      (e.feed as FeedBlock).audience
        .filter((a) => a.kind === "approval_requested")
        .map((a) => `${a.principal}:${a.state}`)
        .sort(),
    );
}

const expectedItems = (h: Held, state: string) =>
  [h.base.owner.principalId, h.writer.principalId].map((id) => `${id}:${state}`).sort();

describe("runs held for approval", () => {
  it("are created held: completed / action_required, no concurrency, no checks, one item for writers", async () => {
    const h = await forkPull();
    // An agent the account trusts to write is no approver.
    const agent = await agentFor(h.base.owner, ["contents:read"]);
    const account = await recordedAccount(env, {
      id: h.base.owner.principalId,
      handle: h.base.owner.handle,
    });
    const granted = await account.setCollaborator(
      { principalId: h.base.owner.principalId },
      h.base.repo.id,
      { id: agent.id, handle: agent.handle },
      "write",
    );
    if (!granted.ok) throw new Error(granted.error);
    await h.base.stub.invalidateAcl(h.base.owner.principalId, granted.epochGen, granted.version);
    const runId = await newestRun(h);
    expect(await viewOf(runId)).toMatchObject({
      status: "queued",
      fork: true,
      trust: "untrusted",
      approval: { state: "waiting", decidedBy: null, decidedAt: null },
    });
    const shown = await json<{ status: string; conclusion: string; approval: { state: string } }>(
      api("GET", `${h.base.path}/actions/runs/${runId}`, h.base.owner.token),
    );
    expect(shown.body).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      approval: { state: "waiting" },
    });
    await runAt(runId, 60_000);
    expect(await jobsOf(runId)).toEqual([]);
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM run_owners"))).toEqual([]);
    const sha = (await viewOf(runId)).sha;
    expect(await inRepo(h.base.stub, (r: RepoDO) => r.checks.summariesOn(sha))).toEqual([]);
    expect(await viewOf(runId)).toMatchObject({ status: "queued", approval: { state: "waiting" } });
    expect(await approvalRow(h, runId)).toEqual([{ state: "waiting", decided_by: null }]);
    expect(await approvalItems(h)).toEqual([expectedItems(h, "open")]);
  });

  it("start when a writer approves, never for a reader or an agent", async () => {
    const h = await forkPull();
    const runId = await newestRun(h);
    expect(await approve(h, runId, h.contributor)).toMatchObject({ status: 404 });
    const agent = await agentFor(h.writer, ["actions:write"]);
    expect(await approve(h, runId, agent.own)).toMatchObject({
      status: 403,
      body: { code: "principal_type_not_allowed" },
    });
    expect(await approve(h, runId, h.writer)).toEqual({ status: 201, body: {} });
    // Approving again answers the same.
    expect(await approve(h, runId, h.writer)).toEqual({ status: 201, body: {} });
    await runAt(runId, 60_000);
    const view = await viewOf(runId);
    expect(view).toMatchObject({
      status: "in_progress",
      approval: { state: "approved", decidedBy: h.writer.principalId },
    });
    expect(await jobsOf(runId)).toHaveLength(1);
    expect(await approvalRow(h, runId)).toEqual([
      { state: "approved", decided_by: h.writer.principalId },
    ]);
    expect((await approvalItems(h)).at(-1)).toEqual(expectedItems(h, "resolved"));
    // The delivery the job would make finds the run approved: nothing changes.
    await deliver(h);
    expect((await viewOf(runId)).approval).toMatchObject({ state: "approved" });
  });

  it("refuse an approver whose role dropped since the snapshot the handler read", async () => {
    const h = await forkPull();
    const runId = await newestRun(h);
    expect(
      (await api("DELETE", `${h.base.path}/collaborators/${h.writer.handle}`, h.base.owner.token))
        .status,
    ).toBeLessThan(300);
    expect(await h.base.stub.approveRun({ runId, approver: h.writer.principalId })).toMatchObject({
      ok: false,
      code: "approver_not_allowed",
    });
    expect(await approvalRow(h, runId)).toEqual([{ state: "waiting", decided_by: null }]);
  });

  it("supersede an older waiting run by a newer push, which needs its own approval", async () => {
    const h = await forkPull();
    const first = await newestRun(h);
    // A force-push and a changed workflow: a new run, with a new binding.
    await synchronize(h, { [CI]: workflowFile("pull_request", "changed") });
    const second = await newestRun(h);
    expect(second).not.toBe(first);
    expect(await approvalRow(h, first)).toEqual([{ state: "superseded", decided_by: null }]);
    expect(await approvalRow(h, second)).toEqual([{ state: "waiting", decided_by: null }]);
    await deliver(h);
    expect(await viewOf(first)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      approval: { state: "superseded" },
    });
    // Approving the old run starts nothing, and the new one still waits.
    expect(await approve(h, first, h.writer)).toMatchObject({
      status: 409,
      body: { code: "approval_not_pending" },
    });
    expect(await viewOf(second)).toMatchObject({
      status: "queued",
      approval: { state: "waiting" },
    });
    // The item stays open while a run waits.
    expect((await approvalItems(h)).at(-1)).toEqual(expectedItems(h, "open"));
  });

  it("need no approval for an author with write, or with a merged pull request", async () => {
    const writerFork = await forkPull(workflowFile("pull_request"), "push");
    const runId = await newestRun(writerFork);
    expect(await viewOf(runId)).toMatchObject({ approval: null, status: "in_progress" });

    const h = await forkPull();
    const held = await newestRun(h);
    expect(await approve(h, held, h.writer)).toMatchObject({ status: 201 });
    const merged = await json(
      api("PUT", `${h.base.path}/pulls/${h.number}/merge`, h.base.owner.token),
    );
    expect(merged.status).toBe(200);
    await runTriggers(h.base.stub);
    await commit({ path: h.fork.path, owner: h.contributor }, "main", { "c.txt": "more\n" });
    const again = await json<{ number: number }>(
      api("POST", `${h.base.path}/pulls`, h.contributor.token, {
        title: "Again",
        head: `${h.contributor.handle}:main`,
        base: "main",
      }),
    );
    expect(again.status).toBe(201);
    const next = await newestRun(h);
    expect(next).not.toBe(held);
    expect(await viewOf(next)).toMatchObject({ approval: null, status: "in_progress" });
  });

  it("settle a held run cancelled by a user, and one that expires after 30 days", async () => {
    const cancelled = await forkPull();
    const runId = await newestRun(cancelled);
    expect(
      (
        await api(
          "POST",
          `${cancelled.base.path}/actions/runs/${runId}/cancel`,
          cancelled.base.owner.token,
          {},
        )
      ).status,
    ).toBe(202);
    expect(await viewOf(runId)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      approval: { state: "cancelled" },
    });
    await runAt(runId, 60_000);
    expect(await approvalRow(cancelled, runId)).toEqual([{ state: "cancelled", decided_by: null }]);
    expect((await approvalItems(cancelled)).at(-1)).toEqual(expectedItems(cancelled, "resolved"));

    const expired = await forkPull();
    const old = await newestRun(expired);
    await runAt(old, 29 * DAY);
    expect(await viewOf(old)).toMatchObject({ status: "queued", approval: { state: "waiting" } });
    await runAt(old, 30 * DAY + 1);
    const view = await viewOf(old);
    expect(view).toMatchObject({
      status: "completed",
      conclusion: "failure",
      approval: { state: "expired" },
    });
    expect(view.errors[0]).toMatchObject({ code: "approval_expired" });
    expect(await approvalRow(expired, old)).toEqual([{ state: "expired", decided_by: null }]);
    expect((await approvalItems(expired)).at(-1)).toEqual(expectedItems(expired, "resolved"));
  });

  it("refuse an approval past the expiry its deadline has not processed, and expire the run", async () => {
    const h = await forkPull();
    const runId = await newestRun(h);
    const [row] = await inRepo(h.base.stub, (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ binding: string }>("SELECT binding FROM ci_approvals WHERE run_id = ?", runId)
        .toArray()
        .map((b) => ({ ...b })),
    );
    const { createdAt } = await viewOf(runId);
    // Past the expiry, with no deadline run: the approval itself finds it expired.
    const answer = await inRun(runId, (run) => {
      (run.context as { now: () => number }).now = () => createdAt + 30 * DAY + 1;
      return run.approve(row?.binding ?? "", h.writer.principalId);
    });
    expect(answer).toEqual({ ok: false, code: "not_waiting" });
    const view = await viewOf(runId);
    expect(view).toMatchObject({
      status: "completed",
      conclusion: "failure",
      startedAt: null,
      approval: { state: "expired", decidedBy: null },
    });
    expect(view.errors[0]).toMatchObject({ code: "approval_expired" });
    expect(await jobsOf(runId)).toEqual([]);
    await runAt(runId, 30 * DAY + 1);
    expect(await approvalRow(h, runId)).toEqual([{ state: "expired", decided_by: null }]);
    expect((await approvalItems(h)).at(-1)).toEqual(expectedItems(h, "resolved"));
  });

  it("never re-run a held run that ended unapproved, nor approve it then", async () => {
    const h = await forkPull();
    const runId = await newestRun(h);
    expect(
      (await api("POST", `${h.base.path}/actions/runs/${runId}/cancel`, h.writer.token, {})).status,
    ).toBe(202);
    expect(await runStub(runId).rerun(h.writer.principalId)).toEqual({
      ok: false,
      code: "approval_required",
    });
    expect(
      await json(api("POST", `${h.base.path}/actions/runs/${runId}/rerun`, h.writer.token, {})),
    ).toMatchObject({ status: 409, body: { code: "approval_required" } });
    await runAt(runId, 60_000);
    expect(await approve(h, runId, h.writer)).toMatchObject({
      status: 409,
      body: { code: "approval_not_pending" },
    });
  });

  it("decide exactly one of an approval and a supersede that race", async () => {
    const h = await forkPull();
    const first = await newestRun(h);
    await commit({ path: h.fork.path, owner: h.contributor }, "main", { "c.txt": "c\n" });
    const follow = async () => {
      for (const id of [h.base.repo.id, h.fork.id, h.base.repo.id])
        for (let i = 0; i < 3; i++) await inRepo(env.REPO.getByName(id), (r: RepoDO) => r.alarm());
      await runTriggers(h.base.stub);
    };
    await Promise.all([approve(h, first, h.writer), follow()]);
    await deliver(h);
    await runAt(first, 60_000);
    const [row] = await approvalRow(h, first);
    expect(["approved", "superseded"]).toContain(row?.state);
    expect((await viewOf(first)).approval).toMatchObject({ state: row?.state });
  });

  it("let nothing approve or supersede a run whose creation has not happened yet", async () => {
    const h = await forkPull();
    await inRepo(h.base.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeStart: () => {
          throw new Error("the run object could not be reached");
        },
      };
    });
    await runTriggers(h.base.stub);
    const [allocated] = await pullRuns(h);
    const runId = allocated?.run_id ?? "";
    expect(allocated?.started_at).toBeNull();
    expect(await runStub(runId).get()).toBeUndefined();
    expect(await approve(h, runId, h.writer)).toMatchObject({
      status: 404,
      body: { code: "run_not_found" },
    });
    expect(await h.base.stub.approveRun({ runId, approver: h.writer.principalId })).toMatchObject({
      ok: false,
      code: "approval_not_pending",
    });
    expect(await approvalRow(h, runId)).toEqual([]);
    expect(await approvalItems(h)).toEqual([]);
  });

  it("admit an approved run with and without workflow concurrency", async () => {
    for (const source of [
      workflowFile("pull_request"),
      `concurrency: fork-runs\n${workflowFile("pull_request")}`,
    ]) {
      const h = await forkPull(source);
      const runId = await newestRun(h);
      expect(await approve(h, runId, h.writer)).toMatchObject({ status: 201 });
      await runAt(runId, 60_000);
      await runAt(runId, 120_000);
      expect(await viewOf(runId)).toMatchObject({ status: "in_progress" });
      expect(await jobsOf(runId)).toHaveLength(1);
    }
  });

  it("open no item for a held run that ended before the trigger recorded its creation", async () => {
    const h = await forkPull();
    await inRepo(h.base.stub, (r: RepoDO) => {
      let once = true;
      r.ciTriggers.hooks = {
        afterStart: () => {
          if (!once) return;
          once = false;
          throw new Error("reset");
        },
      };
    });
    await runTriggers(h.base.stub);
    const [allocated] = await pullRuns(h);
    const runId = allocated?.run_id ?? "";
    expect(allocated?.started_at).toBeNull();
    expect(await approvalRow(h, runId)).toEqual([]);
    // The run expires and tells the repository before the trigger's retry.
    await runAt(runId, 31 * DAY);
    expect(await approvalRow(h, runId)).toEqual([{ state: "expired", decided_by: null }]);
    await runTriggers(h.base.stub);
    expect((await pullRuns(h))[0]?.started_at).not.toBeNull();
    expect(await approvalRow(h, runId)).toEqual([{ state: "expired", decided_by: null }]);
    expect(await approvalItems(h)).toEqual([]);
  });

  it("never let a delayed older event supersede a newer waiting run; it is superseded itself", async () => {
    const h = await forkPull();
    const opened = await newestRun(h);
    // Two pushes: the first one's start fails once, so the second one's run is created first.
    const clock = { now: Date.now() };
    await inRepo(h.base.stub, (r: RepoDO) => {
      (r.git.context as { now: () => number }).now = () => clock.now;
      let failing = true;
      r.ciTriggers.hooks = {
        beforeStart: () => {
          if (failing) {
            failing = false;
            throw new Error("the run object could not be reached");
          }
        },
      };
    });
    await synchronize(h, { "c.txt": "c\n" });
    await runTriggers(h.base.stub);
    expect(await pullRuns(h)).toHaveLength(2);
    await synchronize(h, { "d.txt": "d\n" });
    await runTriggers(h.base.stub);
    // Past the failed start's retry deadline.
    clock.now += 60 * 60_000;
    await runTriggers(h.base.stub);
    const runs = await pullRuns(h);
    expect(runs).toHaveLength(3);
    const [, older, newer] = runs;
    expect(runs[0]?.run_id).toBe(opened);
    expect(await approvalRow(h, opened)).toEqual([{ state: "superseded", decided_by: null }]);
    expect(await approvalRow(h, older?.run_id ?? "")).toEqual([
      { state: "superseded", decided_by: null },
    ]);
    expect(await approvalRow(h, newer?.run_id ?? "")).toEqual([
      { state: "waiting", decided_by: null },
    ]);
  });
});

describe("approval decisions under review", () => {
  /**
   * Two pushes after the pull request opened: the first one's start fails
   * once, so the second one's run is created first; `decide` acts on that
   * newer run before the older one is retried.
   */
  async function delayedOlder(decide: (h: Held, newer: string) => Promise<void>) {
    const h = await forkPull();
    await newestRun(h);
    const clock = { now: Date.now() };
    await inRepo(h.base.stub, (r: RepoDO) => {
      (r.git.context as { now: () => number }).now = () => clock.now;
      let failing = true;
      r.ciTriggers.hooks = {
        beforeStart: () => {
          if (failing) {
            failing = false;
            throw new Error("the run object could not be reached");
          }
        },
      };
    });
    await synchronize(h, { "c.txt": "c\n" });
    await runTriggers(h.base.stub);
    await synchronize(h, { "d.txt": "d\n" });
    await runTriggers(h.base.stub);
    const [, older, newer] = await pullRuns(h);
    expect(older?.started_at).toBeNull();
    await decide(h, newer?.run_id ?? "");
    clock.now += 60 * 60_000;
    await runTriggers(h.base.stub);
    expect((await pullRuns(h))[1]?.started_at).not.toBeNull();
    return { h, older: older?.run_id ?? "", newer: newer?.run_id ?? "" };
  }

  it("supersede a delayed older event's run whatever became of the newer one", async () => {
    const decisions: [string, (h: Held, newer: string) => Promise<void>][] = [
      [
        "approved",
        async (h, newer) => {
          expect(await approve(h, newer, h.writer)).toMatchObject({ status: 201 });
        },
      ],
      [
        "cancelled",
        async (h, newer) => {
          expect(
            (await api("POST", `${h.base.path}/actions/runs/${newer}/cancel`, h.writer.token, {}))
              .status,
          ).toBe(202);
          await runAt(newer, 60_000);
        },
      ],
      [
        "expired",
        async (_h, newer) => {
          await runAt(newer, 31 * DAY);
        },
      ],
    ];
    for (const [state, decide] of decisions) {
      const { h, older, newer } = await delayedOlder(decide);
      expect(await approvalRow(h, newer)).toMatchObject([{ state }]);
      expect(await approvalRow(h, older)).toEqual([{ state: "superseded", decided_by: null }]);
    }
  });

  it("refuse approving a held run its user already cancelled, and correct a recorded approval", async () => {
    const h = await forkPull();
    const runId = await newestRun(h);
    expect(
      (await api("POST", `${h.base.path}/actions/runs/${runId}/cancel`, h.writer.token, {})).status,
    ).toBe(202);
    // The settlement is not delivered yet.
    expect(await approve(h, runId, h.writer)).toMatchObject({
      status: 409,
      body: { code: "approval_not_pending" },
    });
    expect(await approvalRow(h, runId)).toEqual([{ state: "waiting", decided_by: null }]);
    // Recorded by the repository alone (no handler): the run's settlement corrects it.
    expect(await h.base.stub.approveRun({ runId, approver: h.writer.principalId })).toMatchObject({
      ok: true,
    });
    await runAt(runId, 60_000);
    expect(await approvalRow(h, runId)).toMatchObject([{ state: "cancelled" }]);
    expect((await approvalItems(h)).at(-1)).toEqual(expectedItems(h, "resolved"));
  });

  it("resolve the item for a writer notified then demoted to reader", async () => {
    const h = await forkPull();
    const runId = await newestRun(h);
    expect(await approvalItems(h)).toEqual([expectedItems(h, "open")]);
    expect(
      (
        await api("PUT", `${h.base.path}/collaborators/${h.writer.handle}`, h.base.owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBeLessThan(300);
    expect(
      (await api("POST", `${h.base.path}/actions/runs/${runId}/cancel`, h.base.owner.token, {}))
        .status,
    ).toBe(202);
    await runAt(runId, 60_000);
    expect((await approvalItems(h)).at(-1)).toContain(`${h.writer.principalId}:resolved`);
  });

  it("record the first approver on both objects when a second writer approves before delivery", async () => {
    const h = await forkPull();
    const runId = await newestRun(h);
    const second = await user();
    expect(
      (
        await api("PUT", `${h.base.path}/collaborators/${second.handle}`, h.base.owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    expect(await h.base.stub.approveRun({ runId, approver: h.writer.principalId })).toMatchObject({
      ok: true,
    });
    expect(await approve(h, runId, second)).toMatchObject({ status: 201 });
    await deliver(h);
    expect(await approvalRow(h, runId)).toEqual([
      { state: "approved", decided_by: h.writer.principalId },
    ]);
    expect((await viewOf(runId)).approval).toMatchObject({
      state: "approved",
      decidedBy: h.writer.principalId,
    });
  });

  it("name the pull request's approvals in the item, not one run", async () => {
    const h = await forkPull();
    await newestRun(h);
    const members = await inRepo(h.base.stub, (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((row) => (JSON.parse(row.event) as DomainEvent).feed as FeedBlock | undefined)
        .filter((f) => f?.audience.some((a) => a.kind === "approval_requested"))
        .map((f) => f?.member),
    );
    expect(members).toEqual([`approval/${h.number}`]);
  });

  it("hold no run whose workflow fails to plan: it fails at once with its check, and asks no one", async () => {
    const broken = [
      "name: broken",
      "on: pull_request",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    needs: missing",
      "    steps:",
      "      - run: echo",
      "",
    ].join("\n");
    const h = await forkPull(broken);
    const runId = await newestRun(h);
    const view = await viewOf(runId);
    expect(view).toMatchObject({ status: "completed", conclusion: "failure", approval: null });
    await runAt(runId, 60_000);
    const checks = await inRepo(h.base.stub, (r: RepoDO) => r.checks.summariesOn(view.sha));
    expect(checks.map((c) => c.conclusion)).toEqual(["failure"]);
    expect(await approvalRow(h, runId)).toEqual([]);
    expect(await approvalItems(h)).toEqual([]);
  });
});

describe("approval items when the account cannot be reached, and supersede by any newer run", () => {
  /** The account's ACL cannot be pulled, and no snapshot is stored: or back to normal. */
  const aclOutage = (h: Held, on: boolean) =>
    inRepo(h.base.stub, (r: RepoDO) => {
      const repo = r as RepoDO & { savedPullAcl?: RepoDO["pullAcl"] };
      if (on) {
        repo.savedPullAcl ??= repo.pullAcl;
        repo.pullAcl = () => Promise.reject(new Error("account unreachable"));
        r.git.context.storage.sql.exec("DELETE FROM acl_snapshot");
      } else if (repo.savedPullAcl) repo.pullAcl = repo.savedPullAcl;
    });

  it("open the item for every writer once the account can be reached again", async () => {
    const h = await forkPull();
    await aclOutage(h, true);
    const runId = await newestRun(h);
    expect(await approvalRow(h, runId)).toEqual([{ state: "waiting", decided_by: null }]);
    expect(await approvalItems(h)).toEqual([]);
    await aclOutage(h, false);
    await deliver(h);
    expect(await approvalItems(h)).toEqual([expectedItems(h, "open")]);
  });

  it("keep the item's holders while the account cannot be reached and another run still waits", async () => {
    const h = await forkPull(workflowFile("pull_request"), "pull", {
      ".github/workflows/other.yml": workflowFile("pull_request", "other"),
    });
    await runTriggers(h.base.stub);
    const runs = await pullRuns(h);
    expect(runs).toHaveLength(2);
    const opened = await approvalItems(h);
    expect(opened).toEqual([expectedItems(h, "open"), expectedItems(h, "open")]);
    await aclOutage(h, true);
    const cancelled = runs[0]?.run_id ?? "";
    expect(
      (await api("POST", `${h.base.path}/actions/runs/${cancelled}/cancel`, h.base.owner.token, {}))
        .status,
    ).toBe(202);
    await runAt(cancelled, 60_000);
    expect(await approvalRow(h, cancelled)).toMatchObject([{ state: "cancelled" }]);
    // Nothing is resolved or forgotten on an ACL that could not be read.
    expect(await approvalItems(h)).toEqual(opened);
    const holders = await inRepo(h.base.stub, (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ principal: string }>("SELECT principal FROM ci_approval_holders ORDER BY principal")
        .toArray()
        .map((row) => row.principal),
    );
    expect(holders).toEqual([h.base.owner.principalId, h.writer.principalId].sort());
    await aclOutage(h, false);
    await deliver(h);
    expect((await approvalItems(h)).at(-1)).toEqual(expectedItems(h, "open"));
  });

  it("supersede a waiting run by a newer one whose workflow fails to plan", async () => {
    const h = await forkPull();
    const held = await newestRun(h);
    await synchronize(h, { [CI]: "name: broken\non: pull_request\njobs: {}\n" });
    const newer = await newestRun(h);
    expect(newer).not.toBe(held);
    expect(await viewOf(newer)).toMatchObject({ conclusion: "failure", approval: null });
    expect(await approvalRow(h, held)).toEqual([{ state: "superseded", decided_by: null }]);
    expect((await approvalItems(h)).at(-1)).toEqual(expectedItems(h, "resolved"));
  });

  it("supersede a waiting run by a newer one from a contributor trusted since", async () => {
    const h = await forkPull();
    const held = await newestRun(h);
    expect(
      (
        await api(
          "PUT",
          `${h.base.path}/collaborators/${h.contributor.handle}`,
          h.base.owner.token,
          {
            permission: "push",
          },
        )
      ).status,
    ).toBeLessThan(300);
    await synchronize(h, { "c.txt": "c\n" });
    const newer = await newestRun(h);
    expect(newer).not.toBe(held);
    expect(await viewOf(newer)).toMatchObject({ approval: null });
    expect(await approvalRow(h, held)).toEqual([{ state: "superseded", decided_by: null }]);
    // The contributor, a writer now, is told the resolution too.
    expect((await approvalItems(h)).at(-1)).toEqual(
      [...expectedItems(h, "resolved"), `${h.contributor.principalId}:resolved`].sort(),
    );
  });
});
