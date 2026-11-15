// CI runs started from pull request events: each event is evaluated as
// `pull_request` (the head commit's workflows, checked out on
// refs/pull/<n>/head) and as `pull_request_target` (the default branch's
// workflows), with separate identities. A fork's head runs untrusted; a run
// that would wait for a maintainer's approval is not created yet.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordedAccount } from "../src/accounts/grants.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { Result } from "../src/runner/proto/messages.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import {
  type CiRepo,
  ciRepo,
  commit,
  eventRunsOf,
  eventsOf,
  githubOf,
  pushRefs,
  runTriggers,
  sourceOf,
  switchCi,
  viewOf,
  workflowFile,
} from "./helpers/ci-triggers.js";
import { ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  fetchTask,
  newOrg,
  registerRunner,
  tasksVersionOf,
  updateTask,
} from "./helpers/runners.js";
import { at, drain, T0 } from "./helpers/runs.js";

const CI = ".github/workflows/ci.yml";
const PULL = workflowFile("pull_request");

beforeAll(() => switchCi(true));
afterAll(() => switchCi(false));

/** Creates `branch` at main's tip, then commits `files` on it; the head SHA. */
async function branchWith(
  f: CiRepo,
  branch: string,
  files: Record<string, string>,
  message?: string,
) {
  const main = await tipOf(f, "main");
  expect(await pushRefs(f, [{ old: ZERO, new: main, ref: `refs/heads/${branch}` }])).toContain(
    `ok refs/heads/${branch}`,
  );
  return commit(f, branch, files, message);
}

async function tipOf(f: Pick<CiRepo, "path" | "owner">, branch: string): Promise<string> {
  const read = await json<{ sha: string }>(
    api("GET", `${f.path}/commits/${branch}`, f.owner.token),
  );
  expect(read.status).toBe(200);
  return read.body.sha;
}

async function openPull(f: CiRepo, head: string, who: Who = f.owner, extra: object = {}) {
  const opened = await json<{ number: number }>(
    api("POST", `${f.path}/pulls`, who.token, { title: "A change", head, base: "main", ...extra }),
  );
  expect(opened.status).toBe(201);
  return opened.body.number;
}

/** The runs of the repository's events from `from` on, with their trigger kind and event action. */
async function runsSince(f: CiRepo, from: number) {
  const events = new Map((await eventsOf(f.stub)).map((e) => [e.id, e]));
  return (await eventRunsOf(f.stub))
    .filter((r) => r.event_id > from)
    .map((r) => ({
      ...r,
      action: JSON.parse(events.get(r.event_id)?.facts ?? "{}").action as string | undefined,
    }));
}

const lastEventId = async (f: CiRepo) => (await eventsOf(f.stub)).at(-1)?.id ?? 0;

describe("pull request triggers", () => {
  it("start a run on the head commit for opened, synchronize and reopened", async () => {
    const f = await ciRepo({ [CI]: PULL, "a.txt": "one\n" });
    await runTriggers(f.stub);
    const from = await lastEventId(f);
    const opened = await branchWith(f, "feature", { "b.txt": "b\n" });
    const n = await openPull(f, "feature");
    const pushed = await commit(f, "feature", { "b.txt": "bb\n" });
    expect(
      (await api("PATCH", `${f.path}/pulls/${n}`, f.owner.token, { state: "closed" })).status,
    ).toBe(200);
    expect(
      (await api("PATCH", `${f.path}/pulls/${n}`, f.owner.token, { state: "open" })).status,
    ).toBe(200);
    await runTriggers(f.stub);
    const runs = (await runsSince(f, from)).filter((r) => r.trigger_kind === "pull_request");
    expect(runs.map((r) => r.action)).toEqual(["opened", "synchronize", "reopened"]);
    const views = await Promise.all(runs.map((r) => viewOf(r.run_id)));
    expect(views.map((v) => v.sha)).toEqual([opened, pushed, pushed]);
    for (const view of views)
      expect(view).toMatchObject({
        event: "pull_request",
        ref: `refs/pull/${n}/head`,
        trust: "trusted",
        fork: false,
      });
    const github = await githubOf(runs[0]?.run_id ?? "");
    expect(github).toMatchObject({
      event_name: "pull_request",
      ref: `refs/pull/${n}/head`,
      sha: opened,
      head_ref: "feature",
      base_ref: "main",
    });
    expect(github.event).toMatchObject({
      action: "opened",
      number: n,
      pull_request: { number: n, draft: false, head: { ref: "feature" }, base: { ref: "main" } },
    });
    // The closed event matches no default type.
    expect(runs.map((r) => r.run_number)).toEqual([1, 2, 3]);
  });

  it("carry the label of a labeled event and the draft flag in the event", async () => {
    const f = await ciRepo({
      [CI]: workflowFile("{ pull_request: { types: [labeled, opened] } }"),
      "a.txt": "one\n",
    });
    await runTriggers(f.stub);
    await branchWith(f, "feature", { "b.txt": "b\n" });
    const n = await openPull(f, "feature", f.owner, { draft: true });
    expect(
      (await api("POST", `${f.path}/labels`, f.owner.token, { name: "ready", color: "00ff00" }))
        .status,
    ).toBe(201);
    expect(
      (await api("POST", `${f.path}/issues/${n}/labels`, f.owner.token, { labels: ["ready"] }))
        .status,
    ).toBe(200);
    await runTriggers(f.stub);
    const runs = (await runsSince(f, 0)).filter((r) => r.trigger_kind === "pull_request");
    expect(runs.map((r) => r.action)).toEqual(["opened", "labeled"]);
    const labeled = await githubOf(runs[1]?.run_id ?? "");
    expect(labeled.event).toMatchObject({
      action: "labeled",
      label: { name: "ready" },
      pull_request: { draft: true },
      sender: { login: f.owner.handle },
    });
  });

  it("skip pull_request for a head commit that says so, and still run pull_request_target", async () => {
    const both = workflowFile("[pull_request, pull_request_target]");
    const f = await ciRepo({ [CI]: both, "a.txt": "one\n" });
    await runTriggers(f.stub);
    const from = await lastEventId(f);
    await branchWith(f, "feature", { "b.txt": "b\n" }, "change [skip ci]");
    await openPull(f, "feature");
    await runTriggers(f.stub);
    const runs = await runsSince(f, from);
    expect(runs.map((r) => r.trigger_kind)).toEqual(["pull_request_target"]);
  });

  it("give one event's pull_request and pull_request_target runs their own identities across a reset", async () => {
    const f = await ciRepo({
      [CI]: workflowFile("[pull_request, pull_request_target]"),
      "a.txt": "1\n",
    });
    await runTriggers(f.stub);
    const from = await lastEventId(f);
    const headSource = workflowFile("[pull_request, pull_request_target]", "head");
    const head = await branchWith(f, "feature", { [CI]: headSource });
    await openPull(f, "feature");
    await inRepo(f.stub, (r: RepoDO) => {
      let starts = 0;
      r.ciTriggers.hooks = {
        afterStart: () => {
          if (++starts === 1) throw new Error("reset");
        },
      };
    });
    expect((await runTriggers(f.stub)).state).toBe("queued");
    expect((await runTriggers(f.stub)).state).toBe("done");
    const runs = await runsSince(f, from);
    expect(runs.map((r) => r.trigger_kind)).toEqual(["pull_request", "pull_request_target"]);
    expect(new Set(runs.map((r) => r.run_id)).size).toBe(2);
    expect(runs.every((r) => r.started_at !== null)).toBe(true);
    const [pr, target] = await Promise.all(runs.map((r) => viewOf(r.run_id)));
    expect(pr).toMatchObject({ sha: head, event: "pull_request", conclusion: null });
    expect(target).toMatchObject({
      event: "pull_request_target",
      ref: "refs/heads/main",
      conclusion: null,
    });
    expect(await sourceOf(runs[0]?.run_id ?? "")).toBe(headSource);
    expect(await sourceOf(runs[1]?.run_id ?? "")).not.toBe(headSource);
  });

  it("build the same spec after a lost answer, though the default branch moved since", async () => {
    const f = await ciRepo({ [CI]: workflowFile("pull_request_target"), "a.txt": "1\n" });
    await runTriggers(f.stub);
    const main = await tipOf(f, "main");
    await branchWith(f, "feature", { "b.txt": "b\n" });
    await openPull(f, "feature");
    await inRepo(f.stub, (r: RepoDO) => {
      let once = true;
      r.ciTriggers.hooks = {
        afterStart: () => {
          if (!once) return;
          once = false;
          throw new Error("the answer was lost");
        },
      };
    });
    expect((await runTriggers(f.stub)).state).toBe("queued");
    const moved = await commit(f, "main", { "a.txt": "2\n" });
    expect(moved).not.toBe(main);
    await runTriggers(f.stub);
    const target = (await eventRunsOf(f.stub)).filter(
      (r) => r.trigger_kind === "pull_request_target",
    );
    expect(target).toHaveLength(1);
    expect(target[0]?.started_at).not.toBeNull();
    expect(await viewOf(target[0]?.run_id ?? "")).toMatchObject({ sha: main });
  });
});

/**
 * Makes an agent a reader of a repository of `owner`'s account. Agents are
 * not collaborators through the API yet: granted in the account's object.
 */
async function collaborate(owner: Who, repoId: string, agent: { id: string; handle: string }) {
  const account = await recordedAccount(env, { id: owner.principalId, handle: owner.handle });
  const granted = await account.setCollaborator(
    { principalId: owner.principalId },
    repoId,
    { id: agent.id, handle: agent.handle },
    "read",
  );
  if (!granted.ok) throw new Error(granted.error);
  await env.REPO.getByName(repoId).invalidateAcl(
    owner.principalId,
    granted.epochGen,
    granted.version,
  );
}

describe("pull requests from forks", () => {
  let base: CiRepo;
  let contributor: Who;
  let fork: { id: string; name: string; path: string };

  async function forkedBy(permission: "push" | "pull") {
    base = await ciRepo({
      [CI]: workflowFile("pull_request"),
      ".github/workflows/target.yml": workflowFile("pull_request_target", "target"),
      "a.txt": "one\n",
    });
    await runTriggers(base.stub);
    contributor = await user();
    expect(
      (
        await api("PUT", `${base.path}/collaborators/${contributor.handle}`, base.owner.token, {
          permission,
        })
      ).status,
    ).toBe(200);
    const forked = await json<{ id: string; name: string }>(
      api("POST", `${base.path}/forks`, contributor.token, { name: uniqueId("fork") }),
    );
    expect(forked.status).toBe(201);
    fork = { ...forked.body, path: `/repos/${contributor.handle}/${forked.body.name}` };
    return commit({ path: fork.path, owner: contributor }, "main", { "b.txt": "fork\n" });
  }

  it("run the head's workflow untrusted and the default branch's trusted, both as fork jobs", async () => {
    const head = await forkedBy("push");
    const from = await lastEventId(base);
    await openPull(base, `${contributor.handle}:main`, contributor);
    await runTriggers(base.stub);
    const runs = await runsSince(base, from);
    expect(runs.map((r) => [r.trigger_kind, r.workflow_path])).toEqual([
      ["pull_request", CI],
      ["pull_request_target", ".github/workflows/target.yml"],
    ]);
    const [pr, target] = await Promise.all(runs.map((r) => viewOf(r.run_id)));
    expect(pr).toMatchObject({
      sha: head,
      trust: "untrusted",
      fork: true,
      actor: contributor.principalId,
    });
    expect(target).toMatchObject({
      sha: await tipOf(base, "main"),
      ref: "refs/heads/main",
      trust: "trusted",
      fork: true,
    });
  });

  it("judge an agent acting on a fork's pull request by its owner's standing", async () => {
    await forkedBy("push");
    const agent = await agentFor(contributor, ["contents:read"]);
    // The agent alone may only read here and in the fork; its owner may write here.
    await collaborate(base.owner, base.repo.id, agent);
    await collaborate(contributor, fork.id, agent);
    const n = await openPull(base, `${contributor.handle}:main`, contributor);
    await runTriggers(base.stub);
    const from = await lastEventId(base);
    // The author's agent closes and reopens the pull request: the reopened event is the agent's.
    for (const state of ["closed", "open"])
      expect((await api("PATCH", `${base.path}/pulls/${n}`, agent.own, { state })).status).toBe(
        200,
      );
    await runTriggers(base.stub);
    const events = (await eventsOf(base.stub)).filter((e) => e.id > from);
    expect(events.map((e) => [JSON.parse(e.facts).action, e.actor_id])).toEqual([
      ["closed", agent.id],
      ["reopened", agent.id],
    ]);
    expect(events[1]).toMatchObject({ state: "done", outcome: null });
    const runs = await runsSince(base, from);
    expect(runs.map((r) => [r.action, r.trigger_kind])).toEqual([
      ["reopened", "pull_request"],
      ["reopened", "pull_request_target"],
    ]);
    // The run still acts as the agent that caused the event.
    expect(await viewOf(runs[0]?.run_id ?? "")).toMatchObject({
      actor: agent.id,
      trust: "untrusted",
    });
  });

  it("create no run yet for a fork's first-time contributor, recording why", async () => {
    await forkedBy("pull");
    const from = await lastEventId(base);
    await openPull(base, `${contributor.handle}:main`, contributor);
    await runTriggers(base.stub);
    expect(await runsSince(base, from)).toEqual([]);
    const [event] = (await eventsOf(base.stub)).filter((e) => e.id > from);
    expect(event).toMatchObject({
      kind: "pull_request",
      state: "done",
      outcome: "approval_unsupported",
    });
  });
});

describe("the runner's context", () => {
  it("names the attempt and its triggering actor at assignment: the re-runner on a re-run", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const made = await json<{ id: string; name: string }>(
      api("POST", `/orgs/${org.login}/repos`, owner.token, { name: uniqueId("r") }),
    );
    expect(made.status).toBe(201);
    const f: CiRepo = {
      owner,
      repo: made.body,
      path: `/repos/${org.login}/${made.body.name}`,
      stub: env.REPO.getByName(made.body.id),
    };
    await commit(f, "main", { [CI]: workflowFile("push") });
    await runTriggers(f.stub);
    const [allocated] = await eventRunsOf(f.stub);
    const runId = allocated?.run_id ?? "";
    await at(runId, T0);
    await drain(runId);
    const runner = await registerRunner(org.login, owner);
    const first = (await fetchTask(runner, 0)).task;
    if (!first) throw new Error("no task");
    expect(first.context).toMatchObject({
      run_id: runId,
      run_attempt: "1",
      actor: owner.handle,
      triggering_actor: owner.handle,
      repository_owner: org.login,
    });
    expect(await updateTask(runner, first.id, Result.SUCCESS)).toBeDefined();
    await drain(runId);
    const rerunner = await user();
    expect(
      (
        await api("PUT", `/orgs/${org.login}/memberships/${rerunner.handle}`, owner.token, {
          role: "admin",
        })
      ).status,
    ).toBeLessThan(300);
    const rerun = await api("POST", `${f.path}/actions/runs/${runId}/rerun`, rerunner.token, {});
    expect(rerun.status).toBe(201);
    await drain(runId);
    // An older version than the account's: the runner asks for work again.
    expect(await tasksVersionOf(org.id)).toBeGreaterThan(0);
    const second = (await fetchTask(runner, 0)).task;
    if (!second) throw new Error("no task for the re-run");
    expect(second.context).toMatchObject({
      run_attempt: "2",
      actor: owner.handle,
      triggering_actor: rerunner.handle,
    });
  });
});
