// CI runs started by what happens to a repository, against fyrden-api under
// `wrangler dev` with CI on: a real `git push` of workflows, a pull request
// opened and then pushed to, a workflow dispatched over REST (typed inputs,
// refused inputs, one run per Idempotency-Key), a fork's pull request from a
// first-time contributor held until a writer approves it (a reader cannot,
// and a new push needs a new approval), and a schedule's tick fired through
// the test Worker before the repository's alarm could reach it. No operation
// lists a repository's runs,
// so each run is found in its run object's local state and then read
// through the public operations.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  eventually,
  FeedFollower,
  type Forge,
  Git,
  refusal,
  type StoredRun,
  seededRepo,
  startForge,
  storedRunState,
  storedRuns,
} from "./forge.js";

const seam = join(dirname(fileURLToPath(import.meta.url)), "fixtures/run-seam/wrangler.jsonc");
const REPO = "triggers";
/**
 * The schedule's one tick: a whole minute about two hours ahead, so the
 * repository's alarm, armed for it, cannot fire it while the file runs, and
 * a daily cron at that UTC time (past midnight it is tomorrow's, which a
 * daily cron needs nothing more for). The one read of the wall clock for it.
 */
const TICK = Math.ceil((Date.now() + 2 * 60 * 60_000) / 60_000) * 60_000;
const CRON = `${new Date(TICK).getUTCMinutes()} ${new Date(TICK).getUTCHours()} * * *`;

const job = (say: string) => [
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  `      - run: echo ${say}`,
];
const WORKFLOWS: Record<string, string> = {
  ".github/workflows/push.yml": ["name: on push", "on: push", ...job("push")].join("\n"),
  ".github/workflows/pr.yml": ["name: on pull", "on: pull_request", ...job("pull")].join("\n"),
  ".github/workflows/manual.yml": [
    "name: manual",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      target:",
    "        type: string",
    "        required: true",
    "      count:",
    "        type: number",
    "        default: 1",
    "      debug:",
    "        type: boolean",
    "      level:",
    "        type: choice",
    "        options: [low, high]",
    "        default: low",
    ...job("manual"),
  ].join("\n"),
  ".github/workflows/nightly.yml": [
    "name: nightly",
    "on:",
    "  schedule:",
    `    - cron: "${CRON}"`,
    ...job("nightly"),
  ].join("\n"),
};

let forge: Forge;
/** Owns the repository. */
let owner: Account;
/** A collaborator who may write: an approver. */
let writer: Account;
/** A collaborator who may only read; opens pull requests from a fork, never merged before. */
let reader: Account;
let ownerGit: Git;
let readerGit: Git;
let ownerWork = "";
let forkWork = "";
let repoId = "";
/** The commit the workflows were pushed in, main's tip. */
let seeded = "";
let feedStart = "";

const at = () => ({ owner: owner.handle, repo: REPO });

/** The run of `path` for `event` at `sha`, once its trigger has started it (and only one). */
async function runFor(path: string, event: string, sha: string): Promise<StoredRun> {
  const found = await eventually(`a ${event} run of ${path} at ${sha}`, async () => {
    const runs = (await storedRuns(forge, repoId)).filter(
      (r) => r.path === path && r.event === event && r.sha === sha,
    );
    return runs.length > 0 ? runs : undefined;
  });
  expect(found).toHaveLength(1);
  return found[0] as StoredRun;
}

/**
 * A run held for approval, as its run object keeps it: the attempt still
 * queued and no job made, so nothing can be offered to a runner.
 */
const HELD = {
  attempt: { attempt: 1, status: "queued" },
  jobs: [],
  approval: { state: "waiting", decided_by: null },
};

const view = (runId: string) => owner.api.call("actions.runs.get", { ...at(), run_id: runId });

/** A dispatch over REST, as a client without the SDK sends one: the status and body. */
async function dispatch(body: unknown, key: string = crypto.randomUUID()) {
  const res = await fetch(
    `${forge.origin}/api/repos/${owner.handle}/${REPO}/actions/workflows/manual.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  forge = await startForge("triggers", {
    primary: seam,
    vars: { FYRDEN_CI_RUNNERS: "on" },
  });
  owner = forge.admin;
  const suffix = Date.now().toString(36);
  writer = await forge.user(`writer${suffix}`);
  reader = await forge.user(`reader${suffix}`);
  ownerGit = new Git(forge, owner);
  readerGit = new Git(forge, reader);
  ownerWork = await seededRepo(forge, owner, ownerGit, REPO, {
    "README.md": "one\n",
    ...Object.fromEntries(Object.entries(WORKFLOWS).map(([p, text]) => [p, `${text}\n`])),
  });
  seeded = await ownerGit.ok(["rev-parse", "HEAD"], ownerWork);
  repoId = (await owner.api.call("repos.get", at())).id;
  await owner.api.call("repos.collaborators.set", {
    ...at(),
    username: writer.handle,
    permission: "push",
  });
  await owner.api.call("repos.collaborators.set", {
    ...at(),
    username: reader.handle,
    permission: "pull",
  });
  feedStart = (await writer.api.call("feed.sync", {})).head_cursor;
  await reader.api.call("repos.fork", at());
  forkWork = await readerGit.clone(reader.handle, REPO, "fork");
}, 180_000);

afterAll(async () => {
  await forge?.stop();
});

describe("CI runs started by triggers (wrangler dev)", () => {
  it("starts a push run with the pushed commit's github context", async () => {
    const run = await runFor(".github/workflows/push.yml", "push", seeded);
    expect(run.ref).toBe("refs/heads/main");
    expect(run.github).toMatchObject({
      event_name: "push",
      ref: "refs/heads/main",
      ref_name: "main",
      ref_type: "branch",
      sha: seeded,
      head_ref: "",
      base_ref: "",
      actor: owner.handle,
      actor_id: owner.id,
      repository: `${owner.handle}/${REPO}`,
      repository_id: repoId,
      repository_owner: owner.handle,
      workflow: "on push",
      workflow_ref: `${owner.handle}/${REPO}/.github/workflows/push.yml@refs/heads/main`,
      workflow_sha: seeded,
      run_id: run.runId,
      run_number: "1",
      event: { ref: "refs/heads/main", after: seeded, head_commit: { id: seeded } },
    });
    expect(await view(run.runId)).toMatchObject({
      id: run.runId,
      event: "push",
      head_sha: seeded,
      head_branch: "main",
      path: ".github/workflows/push.yml",
      actor: { id: owner.id },
      approval: null,
    });
  });

  it("starts pull request runs when one is opened and when its branch is pushed to", {
    timeout: 180_000,
  }, async () => {
    await ownerGit.ok(["checkout", "-q", "-b", "feature"], ownerWork);
    const first = await ownerGit.commit(ownerWork, { "feature.txt": "one\n" }, "feature: one");
    await ownerGit.ok(["push", "-q", "origin", "feature"], ownerWork);
    const pull = await owner.api.call("pulls.create", {
      ...at(),
      title: "A feature",
      head: "feature",
      base: "main",
    });
    const opened = await runFor(".github/workflows/pr.yml", "pull_request", first);
    const ref = `refs/pull/${pull.number}/head`;
    expect(opened.github).toMatchObject({
      event_name: "pull_request",
      ref,
      sha: first,
      head_ref: "feature",
      base_ref: "main",
      actor: owner.handle,
      repository: `${owner.handle}/${REPO}`,
      event: { action: "opened", number: pull.number },
    });

    const second = await ownerGit.commit(ownerWork, { "feature.txt": "two\n" }, "feature: two");
    await ownerGit.ok(["push", "-q", "origin", "feature"], ownerWork);
    const synchronized = await runFor(".github/workflows/pr.yml", "pull_request", second);
    expect(synchronized.runId).not.toBe(opened.runId);
    expect(synchronized.github).toMatchObject({
      event_name: "pull_request",
      ref,
      sha: second,
      head_ref: "feature",
      base_ref: "main",
      event: { action: "synchronize", number: pull.number },
    });
    // A same-repository pull request needs no approval.
    expect(await view(synchronized.runId)).toMatchObject({
      event: "pull_request",
      head_sha: second,
      approval: null,
    });
  });

  it("dispatches a workflow with typed inputs, and refuses inputs it does not declare", async () => {
    const valid = await dispatch({
      ref: "main",
      inputs: { target: "staging", count: "3", debug: true },
    });
    expect(valid.status, JSON.stringify(valid.body)).toBe(200);
    const runId = valid.body.workflow_run_id as string;
    const path = `${owner.handle}/${REPO}/actions/runs/${runId}`;
    expect(valid.body).toEqual({
      workflow_run_id: runId,
      run_url: `${forge.origin}/api/repos/${path}`,
      html_url: expect.stringMatching(new RegExp(`/${path}$`)),
    });
    const run = await runFor(".github/workflows/manual.yml", "workflow_dispatch", seeded);
    expect(run.runId).toBe(runId);
    // Typed in `inputs`, defaults applied; strings in the event's inputs.
    expect(run.inputs).toEqual({ target: "staging", count: 3, debug: true, level: "low" });
    expect(run.github).toMatchObject({
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      sha: seeded,
      actor: owner.handle,
      event: {
        inputs: { target: "staging", count: "3", debug: "true", level: "low" },
        ref: "refs/heads/main",
        workflow: ".github/workflows/manual.yml",
      },
    });
    expect(await view(runId)).toMatchObject({ id: runId, event: "workflow_dispatch" });

    const invalid = await dispatch({
      ref: "main",
      inputs: { count: "many", level: "medium", unknown: "x" },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({ code: "invalid_inputs" });
    const errors = invalid.body.errors as { input: string; message: string }[];
    expect(errors.map((e) => e.input).sort()).toEqual(["count", "level", "target", "unknown"]);
    for (const error of errors) expect(error.message).not.toBe("");
    // Nothing ran for the refused dispatch.
    expect(
      (await storedRuns(forge, repoId)).filter((r) => r.event === "workflow_dispatch"),
    ).toHaveLength(1);
  });

  it("makes one run for a dispatch sent twice with one Idempotency-Key", async () => {
    const before = (await storedRuns(forge, repoId)).filter((r) => r.event === "workflow_dispatch");
    const key = crypto.randomUUID();
    const body = { ref: "main", inputs: { target: "twice" } };
    const first = await dispatch(body, key);
    const again = await dispatch(body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(again).toEqual(first);
    const runId = first.body.workflow_run_id as string;
    await eventually("the dispatched run", async () =>
      (await storedRuns(forge, repoId)).find((r) => r.runId === runId),
    );
    const after = (await storedRuns(forge, repoId)).filter((r) => r.event === "workflow_dispatch");
    expect(after.map((r) => r.runId)).toEqual([...before.map((r) => r.runId), runId]);
    expect(after.at(-1)?.inputs).toMatchObject({ target: "twice" });
  });

  it("holds a fork's pull request from a first-time contributor until a writer approves it", {
    timeout: 240_000,
  }, async () => {
    await readerGit.ok(["checkout", "-q", "-b", "contribution"], forkWork);
    const first = await readerGit.commit(forkWork, { "fork.txt": "one\n" }, "fork: one");
    await readerGit.ok(["push", "-q", "origin", "contribution"], forkWork);
    const pull = await reader.api.call("pulls.create", {
      ...at(),
      title: "A contribution",
      head: `${reader.handle}:contribution`,
      base: "main",
    });
    expect(pull.head.sha).toBe(first);
    const held = await runFor(".github/workflows/pr.yml", "pull_request", first);
    expect(held.github).toMatchObject({
      event_name: "pull_request",
      ref: `refs/pull/${pull.number}/head`,
      actor: reader.handle,
      event: { action: "opened", number: pull.number },
    });
    expect(await storedRunState(forge, held.runId)).toEqual(HELD);
    // Shown as GitHub shows a run waiting for approval.
    expect(await view(held.runId)).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      approval: { state: "waiting", decided_by: null },
    });
    // The writer is asked, in their feed.
    const feed = new FeedFollower(writer.api, feedStart);
    const asked = await feed.until(forge, pull.number, "approval_requested", "open");
    expect(asked.repo.id).toBe(repoId);

    // A reader may not approve (refused as for a repository it cannot write); the run still waits.
    const refused = await refusal(
      reader.api.call("actions.runs.approve", { ...at(), run_id: held.runId }),
    );
    expect(refused).toMatchObject({ status: 404, code: "repo_not_found" });
    expect((await view(held.runId)).approval).toMatchObject({ state: "waiting" });
    expect(await storedRunState(forge, held.runId)).toEqual(HELD);

    expect(await writer.api.call("actions.runs.approve", { ...at(), run_id: held.runId })).toEqual(
      {},
    );
    // Admitted: its job is made and queued for a runner (none takes it here).
    const admitted = await eventually("the approved run's job", async () => {
      const state = await storedRunState(forge, held.runId);
      return state && state.jobs.length > 0 ? state : undefined;
    });
    expect(admitted).toEqual({
      attempt: { attempt: 1, status: "in_progress" },
      jobs: [{ job: "build", status: "queued" }],
      approval: { state: "approved", decided_by: writer.id },
    });
    expect(await view(held.runId)).toMatchObject({
      status: "in_progress",
      conclusion: null,
      approval: { state: "approved", decided_by: { id: writer.id } },
    });

    // A new push to the pull request is a new run, which needs its own approval.
    const second = await readerGit.commit(forkWork, { "fork.txt": "two\n" }, "fork: two");
    await readerGit.ok(["push", "-q", "origin", "contribution"], forkWork);
    const next = await runFor(".github/workflows/pr.yml", "pull_request", second);
    expect(next.runId).not.toBe(held.runId);
    expect(next.github).toMatchObject({ event: { action: "synchronize", number: pull.number } });
    expect(await storedRunState(forge, next.runId)).toEqual(HELD);
    expect(await view(next.runId)).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      approval: { state: "waiting" },
    });
    // The approved run is not touched by the newer one.
    expect((await view(held.runId)).approval).toMatchObject({ state: "approved" });
  });

  it("starts a schedule run for the tick the test Worker fires, ahead of the alarm", async () => {
    expect((await storedRuns(forge, repoId)).filter((r) => r.event === "schedule")).toEqual([]);
    const res = await fetch(`${forge.origin}/__runs/schedule-tick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId, at: TICK }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await eventually(
      "the tick's schedule run",
      async () => {
        const runs = await storedRuns(forge, repoId);
        return runs.some((r) => r.event === "schedule") ? runs : undefined;
      },
      { timeoutMs: 30_000 },
    );
    const runs = (await storedRuns(forge, repoId)).filter((r) => r.event === "schedule");
    expect(runs).toHaveLength(1);
    const run = runs[0] as StoredRun;
    expect(run).toMatchObject({ path: ".github/workflows/nightly.yml", sha: seeded });
    expect(run.github).toMatchObject({
      event_name: "schedule",
      ref: "refs/heads/main",
      sha: seeded,
      actor: owner.handle,
      repository: `${owner.handle}/${REPO}`,
      event: { schedule: CRON },
    });
    expect(await view(run.runId)).toMatchObject({ event: "schedule", head_sha: seeded });
  });
});
