// Self-hosted runners as the tests drive them: an organization with a
// repository and a commit (runners serve an organization's repositories),
// a registered runner, and the runner protocol's calls as the pinned runner
// sends them. The deployment switch is a Worker variable, so each call runs
// the app against the test env with it set for that call.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { expect } from "vitest";
import { createApp } from "../../src/app.js";
import {
  Result,
  type TaskState,
  type UpdateTaskResponse,
} from "../../src/runner/proto/messages.js";
import { api, json, user, type Who } from "./api.js";
import { ORIGIN } from "./git-http.js";
import {
  decodeFetchTaskResponse,
  decodeRunnerResponse,
  decodeUpdateTaskResponse,
  encodeFetchTaskRequest,
  encodeRegisterRequest,
  encodeUpdateTaskRequest,
} from "./runner-proto.js";
import type { Fixture } from "./runs.js";

/**
 * Room for every runner a test file registers: on Free (the test env's
 * plan) the fleet's cap is deployment-wide, and storage is shared within
 * a file.
 */
export const ROOMY_FLEET: Partial<Env> = { FYRDEN_CI_FLEET: "100000" } as Partial<Env>;

/** Runners on, with room for every runner the file registers. */
export const ON: Partial<Env> = { FYRDEN_CI_RUNNERS: "on", ...ROOMY_FLEET } as Partial<Env>;

/** Runs the app against the test env with some bindings replaced. */
export async function call(path: string, init: RequestInit, overrides: Partial<Env> = ON) {
  const ctx = createExecutionContext();
  const res = await createApp().fetch(
    new Request(`${ORIGIN}${path}`, init),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export type Credentials = { uuid: string; token: string };

export interface RegisteredRunner extends Credentials {
  readonly id: number;
}

/** A runner protocol call, as the pinned runner sends it. */
export function runnerCall(
  method: string,
  body: Uint8Array,
  options: {
    credentials?: Credentials;
    overrides?: Partial<Env>;
    headers?: Record<string, string>;
  } = {},
) {
  return call(
    `/api/actions/runner.v1.RunnerService/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        "CF-Connecting-IP": "198.51.100.40",
        ...(options.credentials && {
          "x-runner-uuid": options.credentials.uuid,
          "x-runner-token": options.credentials.token,
        }),
        ...options.headers,
      },
      body,
    },
    options.overrides ?? ON,
  );
}

export async function connectError(res: Response, code: string, status: number) {
  expect(res.status).toBe(status);
  const body = await res.json<{ code: string; message: string }>();
  expect(body.code).toBe(code);
  return body.message;
}

export async function proto(res: Response) {
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
  expect(res.headers.get("content-type")).toBe("application/proto");
  return new Uint8Array(await res.arrayBuffer());
}

/** A new organization owned by `owner`. */
export async function newOrg(owner: Who): Promise<{ id: string; login: string }> {
  const admin = await user(true);
  const login = uniqueId("org").slice(0, 39);
  const made = await json<{ id: string; login: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  expect(made.status).toBe(201);
  return made.body;
}

/** An organization owned by a new user, with a repository holding one commit on main. */
export async function orgRepo(): Promise<Fixture & { org: { id: string; login: string } }> {
  const owner = await user();
  const org = await newOrg(owner);
  const login = org.login;
  const repo = await json<{ id: string; name: string }>(
    api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
  );
  expect(repo.status).toBe(201);
  const path = `/repos/${login}/${repo.body.name}`;
  const commit = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, {
      branch: "main",
      message: "one",
      changes: [{ path: "a.txt", content: "one\n" }],
    }),
  );
  expect(commit.status).toBe(201);
  return { owner, repo: repo.body, path, sha: commit.body.commit.sha, org };
}

/** A runner registered for `org` through a registration token its owner mints. */
export async function registerRunner(
  org: string,
  owner: Who,
  more: { labels?: string[]; ephemeral?: boolean } = {},
): Promise<RegisteredRunner> {
  const minted = await call(
    `/api/orgs/${org}/actions/runners/registration-token`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
    ON,
  );
  expect(minted.status).toBe(201);
  const { token } = await minted.json<{ token: string }>();
  const res = await runnerCall(
    "Register",
    encodeRegisterRequest({
      name: uniqueId("runner"),
      token,
      agentLabels: [],
      customLabels: [],
      version: "v6.0.0",
      labels: more.labels ?? ["ubuntu-latest"],
      ephemeral: more.ephemeral ?? false,
      capabilities: ["cancelling"],
    }),
  );
  const { runner } = decodeRunnerResponse(await proto(res));
  if (!runner) throw new Error("no runner in the answer");
  return { id: runner.id, uuid: runner.uuid, token: runner.token };
}

/** FetchTask with `version`; the decoded answer. */
export async function fetchTask(
  runner: Credentials,
  version: number,
  options: { overrides?: Partial<Env>; headers?: Record<string, string> } = {},
) {
  const res = await runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: version }), {
    credentials: runner,
    ...options,
  });
  return decodeFetchTaskResponse(await proto(res));
}

/** The job token a task carries; the same in both secrets and in the context. */
export function jobTokenOf(task: {
  secrets: Map<string, string>;
  context?: Record<string, unknown>;
}) {
  const token = task.secrets.get("GITHUB_TOKEN");
  expect(token).toMatch(/^fyrden_job_/);
  expect(task.secrets.get("GITEA_TOKEN")).toBe(token);
  expect(task.context?.token).toBe(token);
  return token as string;
}

export const stateOf = (id: number, result: number = Result.UNSPECIFIED): TaskState => ({
  id,
  result,
  steps: [],
  reportedSteps: [],
});

/** UpdateTask for task `id`; the raw response. */
export function updateTaskRaw(
  runner: Credentials,
  id: number,
  result: number = Result.UNSPECIFIED,
  outputs: Map<string, string> = new Map(),
) {
  return runnerCall(
    "UpdateTask",
    encodeUpdateTaskRequest({ state: stateOf(id, result), outputs }),
    { credentials: runner },
  );
}

export async function updateTask(
  runner: Credentials,
  id: number,
  result: number = Result.UNSPECIFIED,
  outputs: Map<string, string> = new Map(),
): Promise<UpdateTaskResponse> {
  return decodeUpdateTaskResponse(await proto(await updateTaskRaw(runner, id, result, outputs)));
}

export interface PendingRow {
  id: number;
  account_id: string;
  run_id: string;
  job_id: number;
  attempt: number;
  labels: string;
  claimed_by: number | null;
  claim_until: number | null;
}

export const pendingOf = async (runId: string) =>
  (
    await env.DIRECTORY.prepare("SELECT * FROM ci_pending_jobs WHERE run_id = ? ORDER BY id")
      .bind(runId)
      .all<PendingRow>()
  ).results;

export interface TaskRow {
  id: number;
  run_id: string;
  job_id: number;
  task: number | null;
  runner_id: number;
  offered_version: number;
  confirmed_at: number | null;
  ended_at: number | null;
  superseded_at: number | null;
}

export const tasksOfRun = async (runId: string) =>
  (
    await env.DIRECTORY.prepare("SELECT * FROM ci_tasks WHERE run_id = ? ORDER BY id")
      .bind(runId)
      .all<TaskRow>()
  ).results;

export const taskRow = async (id: number) =>
  env.DIRECTORY.prepare("SELECT * FROM ci_tasks WHERE id = ?").bind(id).first<TaskRow>();

export const tasksVersionOf = async (accountId: string) =>
  (
    await env.DIRECTORY.prepare("SELECT tasks_version FROM ci_dispatch WHERE account_id = ?")
      .bind(accountId)
      .first<{ tasks_version: number }>()
  )?.tasks_version ?? 0;

export interface TokenRow {
  id: string;
  principal_id: string;
  type: string;
  scopes: string;
  repo_ids: string | null;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
}

/** The job tokens minted for wire task `id`, oldest first. */
export const jobTokensOf = async (id: number) =>
  (
    await env.DIRECTORY.prepare(
      `SELECT t.* FROM ci_job_tokens j JOIN tokens t ON t.id = j.token_id
       WHERE j.task_id = ? ORDER BY t.rowid`,
    )
      .bind(id)
      .all<TokenRow>()
  ).results;

/** A gate a hook waits on: `started` resolves when the hook is reached, `release` lets it go. */
export function gate() {
  let reached!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    hold: async () => {
      reached();
      await released;
    },
  };
}

/** Job tokens minted for the repository's runs, revoked or not, and how many are revoked. */
export async function repoTokenCounts(
  repoId: string,
): Promise<{ minted: number; revoked: number }> {
  const row = await env.DIRECTORY.prepare(
    `SELECT COUNT(*) AS minted, COUNT(revoked_at) AS revoked FROM tokens
     WHERE type = 'job' AND repo_ids LIKE ?`,
  )
    .bind(`%${repoId}%`)
    .first<{ minted: number; revoked: number }>();
  return { minted: row?.minted ?? 0, revoked: row?.revoked ?? 0 };
}
