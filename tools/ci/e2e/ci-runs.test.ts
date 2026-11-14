// CI runs against fyrden-api under `wrangler dev`, before triggers exist: a
// test Worker in front of the API starts a run through the run seam and
// plays the runner through the run object's calls; everything else goes
// through the public operations (REST through the SDK). A run's jobs queue
// as their needs end, a re-run is a new attempt, a cancel ends the run,
// another repository's run is missing and the actions permission is needed.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  eventually,
  type Forge,
  Git,
  refusal,
  seededRepo,
  startForge,
} from "./forge.js";

const seam = join(dirname(fileURLToPath(import.meta.url)), "fixtures/run-seam/wrangler.jsonc");
const REPO = "runs";
const WORKFLOW = [
  "name: ci",
  "on: push",
  "jobs:",
  "  a:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo a",
  "  b:",
  "    needs: a",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo b",
].join("\n");

let forge: Forge;
let owner: Account;
let repoId = "";
let sha = "";

async function seamCall<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${forge.origin}/__runs${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

async function startRun(): Promise<string> {
  const started = await seamCall<{ runId: string; answer: { ok: boolean } }>("/start", {
    repoId,
    sha,
    ref: "refs/heads/main",
    event: "push",
    actor: owner.id,
    workflow: { path: ".github/workflows/ci.yml", source: WORKFLOW },
    github: { ref: "refs/heads/main", event_name: "push" },
  });
  expect(started.answer.ok).toBe(true);
  return started.runId;
}

const jobsOf = (runId: string) =>
  owner.api.call("actions.runs.jobs.list", { owner: owner.handle, repo: REPO, run_id: runId });

/** Assigns the queued job `name` and completes it with `result`. */
async function runJob(runId: string, name: string, result: string) {
  const job = await eventually(`job ${name} queued`, async () =>
    (await jobsOf(runId)).jobs.find((j) => j.name === name && j.status === "queued"),
  );
  const assigned = await seamCall<{ ok: boolean; task: unknown }>(`/${runId}/assign`, {
    jobId: job.id,
    key: `k-${name}`,
  });
  expect(assigned.ok).toBe(true);
  const done = await seamCall<{ ok: boolean }>(`/${runId}/complete`, {
    task: assigned.task,
    result,
  });
  expect(done.ok).toBe(true);
}

beforeAll(async () => {
  forge = await startForge("runs", { primary: seam });
  owner = forge.admin;
  const git = new Git(forge, owner);
  const work = await seededRepo(forge, owner, git, REPO, { "README.md": "one\n" });
  sha = (await git.ok(["rev-parse", "HEAD"], work)).trim();
  repoId = (await owner.api.call("repos.get", { owner: owner.handle, repo: REPO })).id;
}, 180_000);

afterAll(async () => {
  await forge?.stop();
});

describe("a CI run through the public operations", () => {
  it("runs its jobs as their needs end, re-runs as a new attempt, and cancels", async () => {
    const runId = await startRun();
    const run = await owner.api.call("actions.runs.get", {
      owner: owner.handle,
      repo: REPO,
      run_id: runId,
    });
    expect(run).toMatchObject({ id: runId, status: "in_progress", run_attempt: 1, head_sha: sha });
    await runJob(runId, "a", "success");
    await runJob(runId, "b", "failure");
    const failed = await eventually("run completed", async () => {
      const r = await owner.api.call("actions.runs.get", {
        owner: owner.handle,
        repo: REPO,
        run_id: runId,
      });
      return r.status === "completed" ? r : undefined;
    });
    expect(failed.conclusion).toBe("failure");
    const rerun = await owner.api.call("actions.runs.rerun", {
      owner: owner.handle,
      repo: REPO,
      run_id: runId,
    });
    expect(rerun).toEqual({ run_attempt: 2 });
    await eventually("attempt 2 queued", async () =>
      (await jobsOf(runId)).jobs.find((j) => j.run_attempt === 2 && j.status === "queued"),
    );
    await owner.api.call("actions.runs.cancel", { owner: owner.handle, repo: REPO, run_id: runId });
    const cancelled = await eventually("run cancelled", async () => {
      const r = await owner.api.call("actions.runs.get", {
        owner: owner.handle,
        repo: REPO,
        run_id: runId,
      });
      return r.status === "completed" ? r : undefined;
    });
    expect(cancelled.conclusion).toBe("cancelled");
    expect(
      await refusal(
        owner.api.call("actions.runs.cancel", { owner: owner.handle, repo: REPO, run_id: runId }),
      ),
    ).toMatchObject({ status: 409, code: "run_not_cancellable" });
  });

  it("answers another repository's run as missing, and needs the actions permission", async () => {
    const runId = await startRun();
    await owner.api.call("repos.create", { name: "other" });
    expect(
      await refusal(
        owner.api.call("actions.runs.get", { owner: owner.handle, repo: "other", run_id: runId }),
      ),
    ).toMatchObject({ status: 404, code: "run_not_found" });
    const bot = await forge.user(`ro${Date.now().toString(36)}`);
    await owner.api.call("repos.collaborators.set", {
      owner: owner.handle,
      repo: REPO,
      username: bot.handle,
      permission: "push",
    });
    const token = await owner.api.call("admin.tokens.create", {
      user_id: bot.id,
      type: "pat",
      scopes: ["contents:write", "statuses:write"],
      expires_in_days: 1,
    });
    const scoped = forge.client(token.token);
    expect(
      await refusal(
        scoped.call("actions.runs.get", { owner: owner.handle, repo: REPO, run_id: runId }),
      ),
    ).toMatchObject({ status: 403, code: "missing_permission" });
  });
});
