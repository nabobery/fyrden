// Secrets and variables delivered to a job at assignment. A job gets the
// secrets its expressions name (every eligible one for a dynamic read): the
// organization's first 100 that reach its repository, by name, with the
// repository's own overriding them. An untrusted run gets none and no
// variables, and the account object is never asked. The job token entries are
// written last. Values are read again on every offer and masked before the
// task is answered; one that does not open, or does not fit the mask budget,
// fails the job and hands out nothing. Every secret value made here is
// registered with the log capture, so a log line holding one fails its test.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MASK_SECRET_MAX_TEXT_BYTES, type StoredLogLine } from "@fyrden/domain/ci";
import { uniqueId } from "@fyrden/testing";
import { registerSecretValue } from "@fyrden/testing/log-capture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ciSecretKeys, sealSecretValue, unwrapDataKey } from "../src/ci/envelope.js";
import { accountHooks, type OrgDO } from "../src/do/OrgDO.js";
import type { RunDO } from "../src/do/RunDO.js";
import { RECORD_TASK_SQL } from "../src/do/run/dispatch.js";
import { deliveryBound, deliveryMemory } from "../src/do/run/secrets.js";
import { dispatchHooks, SECRETS_RETRY_MS } from "../src/runner/dispatch.js";
import { Result } from "../src/runner/proto/messages.js";
import { PENDING_COLUMNS } from "../src/runner/registry.js";
import { api, json } from "./helpers/api.js";
import { putSecret, secretValue } from "./helpers/ci-secrets.js";
import {
  decodeTask,
  decodeUpdateLogResponse,
  encodeUpdateLogRequest,
} from "./helpers/runner-proto.js";
import {
  type Credentials,
  fetchTask,
  gate,
  jobTokenOf,
  jobTokensOf,
  orgRepo,
  pendingOf,
  proto,
  type RegisteredRunner,
  registerRunner,
  repoTokenCounts,
  runnerCall,
  taskRow,
  tasksOfRun,
  tasksVersionOf,
  updateTask,
} from "./helpers/runners.js";
import {
  drain,
  expr,
  type Fixture,
  inRun,
  job,
  jobNamed,
  jobsOf,
  now,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";
import { logs } from "./setup/log-capture.js";

type OrgFixture = Fixture & { org: { id: string; login: string } };

/** Calls the account objects answered for a job's secrets. */
let secretReads = 0;
afterEach(() => {
  secretReads = 0;
  delete accountHooks.ciSecretsRead;
});
const countReads = () => {
  secretReads = 0;
  accountHooks.ciSecretsRead = async () => {
    secretReads++;
  };
};

/** A workflow whose job `a` reads `names` as `secrets.<name>`, each into an env entry. */
const reading = (...names: string[]) =>
  workflow(job("a", ["env:", ...names.map((n, k) => `  V${k}: ${expr(`secrets.${n}`)}`)]));

/** A workflow whose job reads the whole `secrets` context. */
const dynamic = workflow(job("a", ["env:", `  ALL: ${expr("toJSON(secrets)")}`]));

/** Another repository of the fixture's organization, with one commit on main. */
async function sibling(f: OrgFixture): Promise<OrgFixture> {
  const repo = await json<{ id: string; name: string }>(
    api("POST", `/orgs/${f.org.login}/repos`, f.owner.token, { name: uniqueId("r") }),
  );
  expect(repo.status).toBe(201);
  const path = `/repos/${f.org.login}/${repo.body.name}`;
  const commit = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, f.owner.token, {
      branch: "main",
      message: "one",
      changes: [{ path: "a.txt", content: "one\n" }],
    }),
  );
  expect(commit.status).toBe(201);
  return { ...f, repo: repo.body, path, sha: commit.body.commit.sha };
}

const orgPath = (f: OrgFixture) => `/orgs/${f.org.login}`;

async function repoSecret(f: OrgFixture, name: string, value = secretValue()) {
  expect((await putSecret(f.owner, f.path, name, value)).status).toBeLessThan(300);
  return value;
}

async function orgSecret(
  f: OrgFixture,
  name: string,
  access: { visibility: "all" | "private" | "selected"; selected_repository_ids?: string[] } = {
    visibility: "all",
  },
  value = secretValue(),
) {
  expect((await putSecret(f.owner, orgPath(f), name, value, access)).status).toBeLessThan(300);
  return value;
}

const account = (f: OrgFixture) => env.ORG.getByName(f.org.id);

/**
 * Writes secrets straight into the account object, sealed as a write seals
 * them, under its newest data key: for names and numbers the API refuses or
 * that would take many requests. The account must have a data key already.
 */
async function plant(
  f: OrgFixture,
  scope: string,
  entries: readonly { name: string; value: string; visibility?: "all" }[],
) {
  await runInDurableObject(account(f), async (_: OrgDO, state) => {
    const sql = state.storage.sql;
    const row = sql
      .exec<{ generation: number; wrapped: string; nonce: string; master_key_id: string }>(
        "SELECT generation, wrapped, nonce, master_key_id FROM ci_data_keys ORDER BY generation DESC LIMIT 1",
      )
      .one();
    const dataKey = await unwrapDataKey(
      await ciSecretKeys(env),
      { accountId: f.org.id, generation: row.generation },
      { masterKeyId: row.master_key_id, nonce: row.nonce, wrapped: row.wrapped },
    );
    if (!dataKey) throw new Error("the account's data key does not open");
    for (const e of entries) {
      const sealed = await sealSecretValue(
        dataKey,
        { accountId: f.org.id, scope, name: e.name, generation: row.generation },
        e.value,
      );
      sql.exec(
        `INSERT INTO ci_secrets (scope, name, generation, nonce, ciphertext, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
        scope,
        e.name,
        row.generation,
        sealed.nonce,
        sealed.ciphertext,
        e.visibility ?? null,
      );
    }
  });
}

/** Runs `source` in the fixture's repository and has a new runner fetch its task. */
async function deliver(f: OrgFixture, source: string, extra = {}) {
  const runId = await started(f, source, extra);
  const runner = await registerRunner(f.org.login, f.owner);
  const task = (await fetchTask(runner, 0)).task;
  return { runId, runner, task };
}

async function delivered(f: OrgFixture, source: string, extra = {}) {
  const got = await deliver(f, source, extra);
  if (!got.task) throw new Error("no task was handed out");
  return { ...got, task: got.task };
}

/** The task's secrets other than the job token entries. */
const ownSecrets = (task: { secrets: Map<string, string> }) =>
  Object.fromEntries(
    [...task.secrets].filter(([k]) => k !== "GITHUB_TOKEN" && k !== "GITEA_TOKEN"),
  );

/**
 * The task a runner is given for a pull request run of the repository's own
 * branch: untrusted for `pull_request`, trusted for `pull_request_target`.
 * A fork's job is never reserved, so never given to a runner
 * (runner-eligibility.test.ts); trust alone decides what is delivered.
 */
async function pullRequestTask(
  f: OrgFixture,
  event: "pull_request" | "pull_request_target",
  source: string,
  vars = {},
) {
  const { task } = await delivered(f, source.replace("on: push", `on: ${event}`), {
    event,
    ref: event === "pull_request" ? "refs/pull/1/head" : "refs/heads/main",
    github: { event_name: event, workflow: "ci" },
    trust: event === "pull_request" ? "untrusted" : "trusted",
    fork: false,
    vars,
  });
  return task;
}

/** A version the organization's runners were told of, with nothing pending. */
async function primed(f: OrgFixture): Promise<number> {
  const runId = await started(f, workflow(job("a")));
  await runStub(runId).cancel(f.owner.principalId, "graceful");
  await drain(runId);
  expect(await pendingOf(runId)).toEqual([]);
  const version = await tasksVersionOf(f.org.id);
  expect(version).toBeGreaterThan(0);
  return version;
}

async function sendLog(runner: Credentials, taskId: number, contents: string[]) {
  const res = await runnerCall(
    "UpdateLog",
    encodeUpdateLogRequest({
      taskId,
      index: 0,
      rows: contents.map((content) => ({ content })),
      noMore: true,
    }),
    { credentials: runner },
  );
  return decodeUpdateLogResponse(await proto(res)).ackIndex;
}

/** The stored lines' text, from every chunk the manifest names. */
async function storedLog(runId: string, wireId: number): Promise<string[]> {
  const task = (await taskRow(wireId))?.task;
  const chunks = await inRun(runId, (r) =>
    r.engine.rows<{ r2_key: string }>(
      "SELECT r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
      task ?? null,
    ),
  );
  const lines: string[] = [];
  for (const chunk of chunks) {
    const object = await env.CI.get(chunk.r2_key);
    for (const text of ((await object?.text()) ?? "").split("\n"))
      if (text !== "") {
        const line = JSON.parse(text) as StoredLogLine;
        lines.push("c" in line ? line.c : "");
      }
  }
  return lines;
}

const jobA = (runId: string) => jobNamed(runId, "a");

// ------------------------------------------------------------------ which secrets

describe("which secrets a job gets", () => {
  it("a repository's secret reaches only that repository's jobs, with the run's variables", async () => {
    const f = await orgRepo();
    const g = await sibling(f);
    const value = await repoSecret(f, "DEPLOY_KEY");
    const own = await delivered(f, reading("DEPLOY_KEY"), { vars: { GREETING: "hello" } });
    expect(ownSecrets(own.task)).toEqual({ DEPLOY_KEY: value });
    expect(Object.fromEntries(own.task.vars)).toEqual({ GREETING: "hello" });
    const other = await delivered(g, reading("DEPLOY_KEY"));
    expect(ownSecrets(other.task)).toEqual({});
    expect(other.task.vars.size).toBe(0);
  });

  it("an organization secret of visibility selected is not delivered to another repository", async () => {
    const f = await orgRepo();
    const g = await sibling(f);
    const value = await orgSecret(f, "SHARED", {
      visibility: "selected",
      selected_repository_ids: [f.repo.id],
    });
    expect(ownSecrets((await delivered(g, reading("SHARED"))).task)).toEqual({});
    expect(ownSecrets((await delivered(f, reading("SHARED"))).task)).toEqual({ SHARED: value });
  });

  it("an organization secret of visibility private is not delivered to a public repository", async () => {
    const f = await orgRepo();
    const g = await sibling(f);
    const value = await orgSecret(f, "PRIV", { visibility: "private" });
    expect(ownSecrets((await delivered(f, reading("PRIV"))).task)).toEqual({ PRIV: value });
    // Reserved while private, then made public: no runner's claim takes a public repository's
    // job, so its run is asked directly, and delivery reads the visibility as it is now.
    const runId = await started(g, reading("PRIV"));
    const runner = await registerRunner(g.org.login, g.owner);
    const { jobId } = await jobA(runId);
    await env.DIRECTORY.prepare("UPDATE repos SET visibility = 'public' WHERE id = ?")
      .bind(g.repo.id)
      .run();
    const offer = await env.DIRECTORY.prepare(
      `INSERT INTO ci_tasks (run_id, job_id, runner_id, offered_version, created_at, repo_id, fork)
       VALUES (?, ?, ?, 0, ?, ?, 0) RETURNING id`,
    )
      .bind(runId, jobId, runner.id, now(runId), g.repo.id)
      .first<{ id: number }>();
    const answer = await runStub(runId).assignTask(offer?.id as number, jobId, runner.id, g.org.id);
    if (!("task" in answer)) throw new Error(`refused: ${answer.refused}`);
    expect(ownSecrets(decodeTask(answer.task))).toEqual({});
  });

  it("the repository's secret overrides the organization's of the same name, compared ignoring case", async () => {
    const f = await orgRepo();
    await orgSecret(f, "TOKEN_X");
    const own = await repoSecret(f, "token_x");
    const { task } = await delivered(f, reading("Token_X"));
    expect(ownSecrets(task)).toEqual({ TOKEN_X: own });
  });

  it("only the secrets a job references are delivered", async () => {
    const f = await orgRepo();
    const a = await repoSecret(f, "A");
    await repoSecret(f, "B");
    await orgSecret(f, "C");
    const { task } = await delivered(f, reading("A", "MISSING"));
    expect(ownSecrets(task)).toEqual({ A: a });
    expect([...task.secrets.keys()].sort()).toEqual(["A", "GITEA_TOKEN", "GITHUB_TOKEN"]);
  });

  it("a dynamic read of the secrets context delivers every eligible secret", async () => {
    const f = await orgRepo();
    const g = await sibling(f);
    const a = await repoSecret(f, "A");
    const b = await repoSecret(f, "B");
    const c = await orgSecret(f, "C");
    await orgSecret(f, "ELSEWHERE", {
      visibility: "selected",
      selected_repository_ids: [g.repo.id],
    });
    const { task } = await delivered(f, dynamic);
    expect(ownSecrets(task)).toEqual({ A: a, B: b, C: c });
  });

  it("an index read with a literal names one secret; another key delivers every one", async () => {
    const f = await orgRepo();
    const a = await repoSecret(f, "A");
    const b = await repoSecret(f, "B");
    const literal = workflow(job("a", ["env:", `  V: ${expr("secrets['a']")}`]));
    expect(ownSecrets((await delivered(f, literal)).task)).toEqual({ A: a });
    const computed = workflow(job("a", ["env:", `  V: ${expr("secrets[format('{0}', 'A')]")}`]));
    expect(ownSecrets((await delivered(f, computed)).task)).toEqual({ A: a, B: b });
  });

  it("takes the first 100 eligible organization secrets by name, before the references and the repository's own", async () => {
    const f = await orgRepo();
    const g = await sibling(f);
    // The organization's first secret makes its data key; the rest are written straight in.
    const first = await orgSecret(f, "S000");
    const values = [first];
    const planted = [];
    for (let k = 1; k <= 100; k++) {
      // Short values keep the hundred within the job's mask budget.
      const value = secretValue(7);
      values.push(value);
      planted.push({ name: `S${String(k).padStart(3, "0")}`, value, visibility: "all" as const });
    }
    await plant(f, "org", planted);
    // One that sorts first but reaches only the sibling takes no place.
    await orgSecret(f, "A_ELSEWHERE", {
      visibility: "selected",
      selected_repository_ids: [g.repo.id],
    });
    const own = await repoSecret(f, "S050");
    const all = (await delivered(f, dynamic)).task;
    const expected: Record<string, string> = {};
    for (let k = 0; k < 100; k++) expected[`S${String(k).padStart(3, "0")}`] = values[k] as string;
    expected.S050 = own;
    expect(ownSecrets(all)).toEqual(expected);
    // Named, the 101st is still not delivered: the cut comes before the references.
    const named = (await delivered(f, reading("S099", "S100"))).task;
    expect(ownSecrets(named)).toEqual({ S099: values[99] });
  });

  it("a secret written under a token's name never overrides the job token", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    // The API refuses these names; written straight in, they are still delivered last-loses.
    const planted = [
      { name: "GITEA_TOKEN", value: secretValue() },
      { name: "GITHUB_TOKEN", value: secretValue() },
    ];
    await plant(f, f.repo.id, planted);
    const { task } = await delivered(f, reading("GITEA_TOKEN", "GITHUB_TOKEN", "A"));
    const token = jobTokenOf(task);
    expect(task.secrets.get("GITEA_TOKEN")).toBe(token);
    expect(task.secrets.get("GITHUB_TOKEN")).toBe(token);
    for (const p of planted) expect([...task.secrets.values()]).not.toContain(p.value);
  });
});

// ------------------------------------------------------------------ trust

describe("trust", () => {
  it("an untrusted pull_request run gets only the job token and no variables, and the account is never asked", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    await orgSecret(f, "B");
    countReads();
    const task = await pullRequestTask(f, "pull_request", dynamic, { GREETING: "hello" });
    expect([...task.secrets.keys()].sort()).toEqual(["GITEA_TOKEN", "GITHUB_TOKEN"]);
    expect(task.vars.size).toBe(0);
    expect(secretReads).toBe(0);
  });

  it("a pull_request_target run, trusted, gets its secrets and variables", async () => {
    const f = await orgRepo();
    const a = await repoSecret(f, "A");
    countReads();
    const task = await pullRequestTask(f, "pull_request_target", reading("A"), {
      GREETING: "hello",
    });
    expect(ownSecrets(task)).toEqual({ A: a });
    expect(Object.fromEntries(task.vars)).toEqual({ GREETING: "hello" });
    expect(secretReads).toBe(1);
  });

  it("a job that references no secret does not ask the account", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    countReads();
    const { task } = await delivered(f, workflow(job("a")));
    expect(ownSecrets(task)).toEqual({});
    expect(secretReads).toBe(0);
  });
});

// ------------------------------------------------------------------ offers and masking

describe("offers and masking", () => {
  it("a secret updated between an offer and its re-offer is delivered fresh, and both values stay masked", async () => {
    const f = await orgRepo();
    const runner: RegisteredRunner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const before = await repoSecret(f, "A");
    countReads();
    const runId = await started(f, reading("A"));
    const lost = (await fetchTask(runner, version)).task;
    if (!lost) throw new Error("no task");
    expect(ownSecrets(lost)).toEqual({ A: before });
    const after = await repoSecret(f, "A");
    const again = (await fetchTask(runner, version)).task;
    if (!again) throw new Error("not offered again");
    expect(again.id).toBe(lost.id);
    expect(ownSecrets(again)).toEqual({ A: after });
    expect(secretReads).toBe(2);
    expect(await sendLog(runner, again.id, [`old ${before}`, `new ${after}`])).toBe(2);
    const lines = await storedLog(runId, again.id);
    expect(lines).toEqual(["old ***", "new ***"]);
  });

  it("a delivered secret printed by the job is masked in the stored log, in its encodings too", async () => {
    const f = await orgRepo();
    // JSON writes a quote, a backslash and a line feed escaped, so its form differs from the text.
    const value = await repoSecret(
      f,
      "A",
      registerSecretValue(`${secretValue()}"\\\n${secretValue()}`),
    );
    const { runId, runner, task } = await delivered(f, reading("A"));
    const ack = await sendLog(runner, task.id, [
      `plain ${value}`,
      `base64 ${btoa(value)}`,
      `json "${JSON.stringify(value).slice(1, -1)}"`,
    ]);
    expect(ack).toBe(3);
    const lines = await storedLog(runId, task.id);
    expect(lines).toEqual(["plain ***", "base64 ***", 'json "***"']);
  });
});

// ------------------------------------------------------------------ failures

describe("failures fail closed", () => {
  it.each(["data key", "ciphertext"] as const)(
    "a %s that does not open fails the job with secrets_unavailable, hands out nothing and mints no token",
    async (broken) => {
      const f = await orgRepo();
      await repoSecret(f, "A");
      const b = await repoSecret(f, "B");
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))));
      await runInDurableObject(account(f), (_: OrgDO, state) => {
        if (broken === "data key")
          state.storage.sql.exec("UPDATE ci_data_keys SET nonce = ?", nonce);
        else state.storage.sql.exec("UPDATE ci_secrets SET nonce = ? WHERE name = 'A'", nonce);
      });
      const tokensBefore = await repoTokenCounts(f.repo.id);
      const { runId, task } = await deliver(f, reading("A", "B"));
      expect(task).toBeUndefined();
      await drain(runId);
      const [only] = await jobsOf(runId);
      expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(only?.error).toBe(
        `secrets_unavailable: these secrets do not open with the deployment's CI keys: ${broken === "data key" ? "A, B" : "A"}`,
      );
      expect(only?.error).not.toContain(b);
      // No token was minted for the repository at all, mapped to an offer or not.
      expect(await repoTokenCounts(f.repo.id)).toEqual(tokensBefore);
    },
  );

  it("secrets past the mask budget fail the job with secrets_unmaskable, naming them and their sizes", async () => {
    const f = await orgRepo();
    // One line of 40 KiB: masked by its line alone, which is more variant text than a job may have.
    const value = await repoSecret(f, "LARGE", secretValue(40 * 1024));
    const { runId, task } = await deliver(f, reading("LARGE"));
    expect(task).toBeUndefined();
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(/^secrets_unmaskable: /);
    expect(only?.error).toContain(`LARGE (${40 * 1024} bytes`);
    expect(only?.error).not.toContain(value.slice(0, 40));
    const offers = await env.DIRECTORY.prepare("SELECT id FROM ci_tasks WHERE run_id = ?")
      .bind(runId)
      .all<{ id: number }>();
    for (const o of offers.results) expect(await jobTokensOf(o.id)).toEqual([]);
  });

  it("an account object that fails keeps the job queued, hands out nothing, and the next poll delivers", async () => {
    const f = await orgRepo();
    const value = await repoSecret(f, "A");
    accountHooks.ciSecretsRead = async () => {
      secretReads++;
      throw new Error("the account object is unreachable");
    };
    const { runId, runner, task } = await deliver(f, reading("A"));
    expect(task).toBeUndefined();
    expect(secretReads).toBe(1);
    expect(await jobA(runId)).toMatchObject({ status: "queued" });
    const offers = await env.DIRECTORY.prepare("SELECT id FROM ci_tasks WHERE run_id = ?")
      .bind(runId)
      .all<{ id: number }>();
    for (const o of offers.results) expect(await jobTokensOf(o.id)).toEqual([]);
    countReads();
    // Released with a retry delay: once it has passed, the next poll is given the job.
    vi.setSystemTime(Date.now() + SECRETS_RETRY_MS + 1);
    const next = (await fetchTask(runner, 0)).task;
    expect(next && ownSecrets(next)).toEqual({ A: value });
    expect(secretReads).toBe(1);
  });

  it("an account object that fails on a re-offer keeps the offer, which is made again", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const value = await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    const lost = (await fetchTask(runner, version)).task;
    if (!lost) throw new Error("no task");
    accountHooks.ciSecretsRead = async () => {
      throw new Error("the account object is unreachable");
    };
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    expect(await taskRow(lost.id)).toMatchObject({ superseded_at: null, ended_at: null });
    expect(await jobA(runId)).toMatchObject({ status: "in_progress" });
    expect(await jobTokensOf(lost.id)).toHaveLength(1);
    delete accountHooks.ciSecretsRead;
    const again = (await fetchTask(runner, version)).task;
    expect(again?.id).toBe(lost.id);
    expect(again && ownSecrets(again)).toEqual({ A: value });
  });
});

/** Makes the stored secret `name` fail to open, as a ciphertext that does not authenticate. */
async function breakSecret(f: OrgFixture, name: string) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))));
  await runInDurableObject(account(f), (_: OrgDO, state) => {
    state.storage.sql.exec("UPDATE ci_secrets SET nonce = ? WHERE name = ?", nonce, name);
  });
}

/** Makes the secret `name` undeliverable: past the mask budget, or not opening. */
async function undeliverable(f: OrgFixture, name: string, how: "unmaskable" | "unopenable") {
  if (how === "unmaskable") await repoSecret(f, name, secretValue(40 * 1024));
  else await breakSecret(f, name);
}

/** Waits for `held` to be reached, failing at once when `request` settles first. */
async function reached(held: ReturnType<typeof gate>, request: Promise<unknown>) {
  await Promise.race([
    held.started,
    request.then(() => {
      throw new Error("the request settled before its gate");
    }),
  ]);
}

describe("a re-offer whose secrets cannot be delivered", () => {
  it.each(["unmaskable", "unopenable"] as const)(
    "secrets turned %s after an answer keep that answer's task and token, and nothing is minted",
    async (how) => {
      const f = await orgRepo();
      const runner = await registerRunner(f.org.login, f.owner);
      const version = await primed(f);
      const before = await repoSecret(f, "A");
      const runId = await started(f, reading("A"));
      // The runner has this answer; it polls again at the same version as if it had not.
      const answered = (await fetchTask(runner, version)).task;
      if (!answered) throw new Error("no task");
      expect(ownSecrets(answered)).toEqual({ A: before });
      await undeliverable(f, "A", how);
      const refused = await fetchTask(runner, version);
      expect(refused.task).toBeUndefined();
      // Retryable: the runner keeps its version, so the offer is made again.
      expect(refused.tasksVersion).toBe(version);
      expect(await jobA(runId)).toMatchObject({ status: "in_progress" });
      expect(await taskRow(answered.id)).toMatchObject({ ended_at: null, superseded_at: null });
      const tokens = await jobTokensOf(answered.id);
      expect(tokens.map((t) => t.revoked_at)).toEqual([null]);
      const report = await updateTask(runner, answered.id);
      expect(report.state).toMatchObject({ id: answered.id, result: Result.UNSPECIFIED });
      await drain(runId);
      expect(await jobA(runId)).toMatchObject({ status: "in_progress" });
      expect((await jobTokensOf(answered.id)).map((t) => t.revoked_at)).toEqual([null]);
    },
  );

  it("a first answer still being made is handed out and keeps reporting", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const before = await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    const held = gate();
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = { afterMint: () => (++calls === 1 ? held.hold() : undefined) };
    });
    const pending: Promise<unknown>[] = [];
    try {
      const first = fetchTask(runner, version);
      pending.push(first);
      await reached(held, first);
      await undeliverable(f, "A", "unmaskable");
      // The runner's poll timed out on its side; it asks again at the same version.
      expect((await fetchTask(runner, version)).task).toBeUndefined();
      held.release();
      const answered = (await first).task;
      if (!answered) throw new Error("the first answer was not handed out");
      expect(ownSecrets(answered)).toEqual({ A: before });
      expect(calls).toBe(1);
      const report = await updateTask(runner, answered.id);
      expect(report.state).toMatchObject({ id: answered.id, result: Result.UNSPECIFIED });
      expect(await jobA(runId)).toMatchObject({ status: "in_progress" });
      expect((await jobTokensOf(answered.id)).map((t) => t.revoked_at)).toEqual([null]);
    } finally {
      held.release();
      await Promise.allSettled(pending);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
  });
  it("a first offer whose masks fail after a re-offer was answered keeps that answer's job", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    await repoSecret(f, "A", secretValue(40 * 1024));
    const runId = await started(f, reading("A"));
    const held = gate();
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = { beforeSecretMasks: () => (++calls === 1 ? held.hold() : undefined) };
    });
    const pending: Promise<unknown>[] = [];
    try {
      // The first offer read the value past the budget and is about to mask it.
      const first = fetchTask(runner, version);
      pending.push(first);
      await reached(held, first);
      // The value is replaced, and the runner's next poll at the same version is answered.
      const small = await repoSecret(f, "A");
      const answered = (await fetchTask(runner, version)).task;
      if (!answered) throw new Error("the re-offer was not answered");
      expect(ownSecrets(answered)).toEqual({ A: small });
      held.release();
      expect((await first).task).toBeUndefined();
      expect(await jobA(runId)).toMatchObject({ status: "in_progress" });
      const report = await updateTask(runner, answered.id);
      expect(report.state).toMatchObject({ id: answered.id, result: Result.UNSPECIFIED });
      expect((await jobTokensOf(answered.id)).map((t) => t.revoked_at)).toEqual([null]);
    } finally {
      held.release();
      await Promise.allSettled(pending);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
  });
});

describe("a first offer whose secrets cannot be delivered", () => {
  it("fails its job after an assignment died before the directory recorded it, and leaves an ephemeral runner usable", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const version = await primed(f);
    await repoSecret(f, "LARGE", secretValue(40 * 1024));
    const runId = await started(f, reading("LARGE"));
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = {
        beforeSecretMasks: () => {
          // The first assignment dies after reading the secrets, as on a reset.
          if (++calls === 1) throw new Error("the run object was reset");
        },
      };
    });
    try {
      await expect(fetchTask(runner, version)).rejects.toThrow();
      expect((await tasksOfRun(runId)).map((t) => t.task)).toEqual([null]);
      // The runner asks again at its version, and the offer is made again.
      expect((await fetchTask(runner, version)).task).toBeUndefined();
    } finally {
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
    expect(calls).toBe(2);
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(/^secrets_unmaskable: /);
    for (const t of await tasksOfRun(runId)) {
      expect(t.task).toBeNull();
      expect(t.ended_at ?? t.superseded_at).not.toBeNull();
      expect(await jobTokensOf(t.id)).toEqual([]);
    }
    expect(await credentialOf(runner)).toEqual({ expires_at: null, task_confirmed_at: null });
    const healthy = await started(f, workflow(job("a")));
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("the ephemeral runner was given no other job");
    expect((await taskRow(task.id))?.run_id).toBe(healthy);
  });

  it("a failing attempt that ends the offer first leaves an overlapping attempt nothing to record", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    const held = gate();
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = { beforeTaskRecord: () => (++calls === 1 ? held.hold() : undefined) };
    });
    const pending: Promise<unknown>[] = [];
    try {
      // The first attempt has masked the secret and is about to record its task.
      const first = fetchTask(runner, version);
      pending.push(first);
      await reached(held, first);
      // The value grows past the budget, and an overlapping attempt of the same offer reads it:
      // the offer was never recorded, so it ends the offer and fails the job.
      await undeliverable(f, "A", "unmaskable");
      expect((await fetchTask(runner, version)).task).toBeUndefined();
      expect(await jobA(runId)).toMatchObject({ status: "completed", conclusion: "failure" });
      // The first attempt's record loses to that end: it hands nothing out and mints nothing.
      held.release();
      expect((await first).task).toBeUndefined();
      for (const t of await tasksOfRun(runId)) {
        expect(t.task).toBeNull();
        expect(t.ended_at).not.toBeNull();
        expect(await jobTokensOf(t.id)).toEqual([]);
      }
      const [only] = await jobsOf(runId);
      expect(only?.error).toMatch(/^secrets_unmaskable: /);
    } finally {
      held.release();
      await Promise.allSettled(pending);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
  });

  it("an attempt still masking when an overlapping one fails the job hands nothing out and mints nothing", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    const held = gate();
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = { beforeSecretMasks: () => (++calls === 1 ? held.hold() : undefined) };
    });
    const pending: Promise<unknown>[] = [];
    try {
      const first = fetchTask(runner, version);
      pending.push(first);
      await reached(held, first);
      await undeliverable(f, "A", "unmaskable");
      expect((await fetchTask(runner, version)).task).toBeUndefined();
      expect(await jobA(runId)).toMatchObject({ status: "completed", conclusion: "failure" });
      held.release();
      expect((await first).task).toBeUndefined();
      for (const t of await tasksOfRun(runId)) {
        expect(t.task).toBeNull();
        expect(await jobTokensOf(t.id)).toEqual([]);
      }
    } finally {
      held.release();
      await Promise.allSettled(pending);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
  });
});

/** An ephemeral runner's credential: unspent while both are null. */
const credentialOf = (runner: RegisteredRunner) =>
  env.DIRECTORY.prepare("SELECT expires_at, task_confirmed_at FROM ci_runners WHERE id = ?")
    .bind(runner.id)
    .first<{ expires_at: number | null; task_confirmed_at: number | null }>();

describe("an ephemeral runner and a failed first offer", () => {
  it("an offer whose refusal the Worker could not write was ended by the run, and leaves the runner free", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    await breakSecret(f, "A");
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const failing = await started(f, reading("A"));
    dispatchHooks.beforeRefuse = () => {
      throw new Error("the directory write failed");
    };
    try {
      await expect(fetchTask(runner, 0)).rejects.toThrow();
    } finally {
      delete dispatchHooks.beforeRefuse;
    }
    expect(await jobA(failing)).toMatchObject({ status: "completed", conclusion: "failure" });
    // Ended unrecorded by the run before it answered, so the offer no longer counts.
    const [offer] = await tasksOfRun(failing);
    expect(offer).toMatchObject({ task: null, superseded_at: null });
    expect(offer?.ended_at).not.toBeNull();
    await drain(failing);
    expect(await credentialOf(runner)).toEqual({ expires_at: null, task_confirmed_at: null });
    const healthy = await started(f, workflow(job("a")));
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("the ephemeral runner was given no other job");
    expect((await taskRow(task.id))?.run_id).toBe(healthy);
  });

  it("an offer whose end the run could not write stands, and the job fails when it is made again", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const failing = await started(f, reading("A"));
    await breakSecret(f, "A");
    let calls = 0;
    await inRun(failing, (r) => {
      r.hooks = {
        beforeDeliveryFailure: () => {
          if (++calls === 1) throw new Error("the directory write failed");
        },
      };
    });
    try {
      const refused = await fetchTask(runner, version);
      expect(refused.task).toBeUndefined();
      expect(refused.tasksVersion).toBe(version);
      expect(await jobA(failing)).toMatchObject({ status: "in_progress" });
      expect(await tasksOfRun(failing)).toMatchObject([
        { task: null, ended_at: null, superseded_at: null },
      ]);
      expect((await fetchTask(runner, version)).task).toBeUndefined();
    } finally {
      await inRun(failing, (r) => {
        r.hooks = {};
      });
    }
    expect(calls).toBe(2);
    await drain(failing);
    const [only] = await jobsOf(failing);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(/^secrets_unavailable: /);
  });

  it("an offer the directory never recorded spends no credential when its task ends", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const runId = await started(f, workflow(job("a")));
    // The offer is given up (its poll's deadline) while the run is about to record it.
    await inRun(runId, (r) => {
      r.hooks = {
        beforeTaskRecord: async () => {
          await env.DIRECTORY.prepare("UPDATE ci_tasks SET superseded_at = 1 WHERE run_id = ?")
            .bind(runId)
            .run();
        },
      };
    });
    try {
      expect((await fetchTask(runner, 0)).task).toBeUndefined();
    } finally {
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
    expect((await tasksOfRun(runId)).map((t) => t.task)).toEqual([null]);
    await runStub(runId).cancel(f.owner.principalId, "force");
    await drain(runId);
    expect(await jobA(runId)).toMatchObject({ status: "completed" });
    expect(await credentialOf(runner)).toEqual({ expires_at: null, task_confirmed_at: null });
  });

  it("a job failed for its secrets before any answer leaves the runner's credential unspent", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    await breakSecret(f, "A");
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const failing = await started(f, reading("A"));
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    await drain(failing);
    expect(await jobA(failing)).toMatchObject({ status: "completed", conclusion: "failure" });
    for (const t of await tasksOfRun(failing)) expect(t.ended_at ?? t.superseded_at).not.toBeNull();
    const credential = await env.DIRECTORY.prepare(
      "SELECT expires_at, task_confirmed_at FROM ci_runners WHERE id = ?",
    )
      .bind(runner.id)
      .first<{ expires_at: number | null; task_confirmed_at: number | null }>();
    expect(credential).toEqual({ expires_at: null, task_confirmed_at: null });
    const healthy = await started(f, workflow(job("a")));
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("the ephemeral runner was given no other job");
    expect((await taskRow(task.id))?.run_id).toBe(healthy);
  });
});

describe("a job whose account does not answer", () => {
  const unreachable = () => {
    accountHooks.ciSecretsRead = async () => {
      secretReads++;
      throw new Error("the account object is unreachable");
    };
  };

  it("is logged as a stable reason, never with its error's text", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    // The registry fails this test if the error's text reaches a log line.
    const carried = secretValue();
    accountHooks.ciSecretsRead = async () => {
      throw new Error(`the account object failed while holding ${carried}`);
    };
    const runner = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await jobA(runId)).toMatchObject({ status: "queued" });
    const withheld = logs
      .entries()
      .filter(
        (e) => e.msg === "task withheld: its repository's account did not answer for its secrets",
      );
    expect(withheld.map((e) => e.reason)).toEqual(["secrets_read_failed"]);
  });

  it("answers a failure inside the account object as a typed refusal, never as an exception", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    const carried = secretValue();
    accountHooks.ciSecretsRead = async () => {
      throw new Error(`the account object failed while holding ${carried}`);
    };
    // An exception would leave the object with its text; workerd's own output of one is not
    // captured here, so the answer's shape is what this proves.
    const bound = deliveryBound({ kind: "all" });
    const answer = await account(f).ciSecretsFor(f.repo.id, { kind: "all" }, bound.bytes);
    expect(answer).toMatchObject({ ok: false, code: "secrets_read_failed" });
    expect(JSON.stringify(answer)).not.toContain(carried);
  });

  it("is held back for a while once released, so later polls reach other jobs", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    const stuck = [];
    for (let k = 0; k < 3; k++) stuck.push(await started(f, reading("A")));
    const healthy = await started(f, workflow(job("a")));
    const runner = await registerRunner(f.org.login, f.owner);
    unreachable();
    // The clock stands still, so the retry delay cannot lapse while the polls run.
    const at = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    const first = await fetchTask(runner, 0);
    expect(first.task).toBeUndefined();
    expect(first.tasksVersion).toBe(0);
    expect(secretReads).toBe(3);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("the poll got no task");
    expect((await taskRow(task.id))?.run_id).toBe(healthy);
    expect(secretReads).toBe(3);
    for (const runId of stuck) {
      expect(await jobA(runId)).toMatchObject({ status: "queued" });
      expect((await pendingOf(runId)).map((p) => p.claimed_by)).toEqual([null]);
    }
    // Once the delay passes, the jobs are claimed again.
    vi.setSystemTime(at + SECRETS_RETRY_MS + 1);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(secretReads).toBe(6);
  });

  it("is skipped on a claim, and the same poll gets a later job with no secret references", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    const stuck = await started(f, reading("A"));
    const healthy = await started(f, workflow(job("a")));
    const runner = await registerRunner(f.org.login, f.owner);
    unreachable();
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error("the poll got no task");
    expect((await taskRow(task.id))?.run_id).toBe(healthy);
    expect(secretReads).toBe(1);
    expect(await jobA(stuck)).toMatchObject({ status: "queued" });
    expect((await pendingOf(stuck)).map((p) => p.claimed_by)).toEqual([null]);
  });

  it("is skipped on a re-offer, which stands, and the same poll gets a later job", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    await repoSecret(f, "A");
    const stuck = await started(f, reading("A"));
    const lost = (await fetchTask(runner, version)).task;
    if (!lost) throw new Error("no task");
    const healthy = await started(f, workflow(job("a")));
    unreachable();
    const task = (await fetchTask(runner, version)).task;
    if (!task) throw new Error("the poll got no task");
    expect((await taskRow(task.id))?.run_id).toBe(healthy);
    expect(await taskRow(lost.id)).toMatchObject({ superseded_at: null, ended_at: null });
    expect(await jobA(stuck)).toMatchObject({ status: "in_progress" });
    expect((await jobTokensOf(lost.id)).map((t) => t.revoked_at)).toEqual([null]);
  });
});

describe("the run object's memory for a job's secrets", () => {
  type Held = ReturnType<RunDO["memory"]["tryReserve"]>;
  const reservedOf = (runId: string) => inRun(runId, (r) => r.memory.stats().reservedBytes);

  it("a pool held by other work refuses the assignment retryably, before the account is asked", async () => {
    const f = await orgRepo();
    const value = await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    const prior = await reservedOf(runId);
    let held: Held;
    await inRun(runId, (r) => {
      const { totalBytes, reservedBytes } = r.memory.stats();
      held = r.memory.tryReserve(totalBytes - reservedBytes);
    });
    countReads();
    const runner = await registerRunner(f.org.login, f.owner);
    try {
      expect((await fetchTask(runner, 0)).task).toBeUndefined();
      expect(secretReads).toBe(0);
      expect(await jobA(runId)).toMatchObject({ status: "queued" });
      for (const t of await tasksOfRun(runId)) {
        expect(t.task).toBeNull();
        expect(await jobTokensOf(t.id)).toEqual([]);
      }
    } finally {
      await inRun(runId, () => held?.release());
    }
    expect(await reservedOf(runId)).toBe(prior);
    vi.setSystemTime(Date.now() + SECRETS_RETRY_MS + 1);
    const task = (await fetchTask(runner, 0)).task;
    expect(task && ownSecrets(task)).toEqual({ A: value });
    expect(await reservedOf(runId)).toBe(prior);
  });

  it("reserves room for the stored masks a re-offer opens and the copies masking and encoding make", () => {
    // The task's secret masks can hold the whole budget (256 KiB of value text): read sealed
    // (base64, 2 bytes a character), opened, and the new ones sealed again.
    const sealedMasks = 2 * Math.ceil((4 * MASK_SECRET_MAX_TEXT_BYTES) / 3);
    const atLeast = 2 * sealedMasks + 2 * MASK_SECRET_MAX_TEXT_BYTES;
    const one = { kind: "names", names: ["A"] } as const;
    expect(deliveryMemory(one)).toBeGreaterThan(atLeast);
    // The largest delivery still leaves the run's pool room for other work.
    expect(deliveryMemory({ kind: "all" })).toBeLessThan(10 * 1024 * 1024);
  });

  it("is given back after a failed delivery", async () => {
    const f = await orgRepo();
    await repoSecret(f, "LARGE", secretValue(40 * 1024));
    const runId = await started(f, reading("LARGE"));
    const prior = await reservedOf(runId);
    const runner = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    await drain(runId);
    expect(await jobA(runId)).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(await reservedOf(runId)).toBe(prior);
  });
});

/**
 * A registered value of `bytes` bytes made of one line repeated: past 4 KiB a value is masked by
 * its lines, so its masked forms are that line's, and it fits a job's masks.
 */
function linesValue(bytes: number): string {
  const line = secretValue();
  return registerSecretValue(
    `${`${line}\n`.repeat(Math.ceil(bytes / (line.length + 1))).slice(0, bytes - 1)}\n`,
  );
}

const SIX = ["A", "B", "C", "D", "E", "F"];

describe("secrets past what a job's masks can take", () => {
  it("six names holding one 48 KiB value are one value to mask, and the job gets all six", async () => {
    const f = await orgRepo();
    const value = linesValue(48 * 1024);
    for (const name of SIX) await repoSecret(f, name, value);
    const { task } = await delivered(f, dynamic);
    expect(ownSecrets(task)).toEqual(Object.fromEntries(SIX.map((n) => [n, value])));
  });

  it("six distinct 48 KiB values are past the masks' value text: the job fails with secrets_unmaskable", async () => {
    const f = await orgRepo();
    const size = 48 * 1024;
    for (const name of SIX) await repoSecret(f, name, linesValue(size));
    const { runId, task } = await deliver(f, dynamic);
    expect(task).toBeUndefined();
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(
      /^secrets_unmaskable: these secrets are past a job's mask budget of 256 KiB of value text: A \(49152 bytes, \d+ bytes of masked forms\)/,
    );
  });

  it("are not sent by the account past what a job may be given: the job fails, naming them and their sizes", async () => {
    const f = await orgRepo();
    const size = 48 * 1024;
    // Eleven of the largest values, however equal: more than a job is given (512 KiB).
    const names = Array.from({ length: 11 }, (_, k) => `S${String(k).padStart(2, "0")}`);
    const value = linesValue(size);
    for (const name of names) await repoSecret(f, name, value);
    const bound = deliveryBound({ kind: "all" });
    const answer = await account(f).ciSecretsFor(f.repo.id, { kind: "all" }, bound.bytes);
    if (!answer.ok) throw new Error(answer.code);
    expect(answer.value.entries).toEqual([]);
    expect(answer.value.oversize?.map((s) => [s.name, s.bytes])).toEqual(
      names.map((n) => [n, size]),
    );
    const { runId, task } = await deliver(f, dynamic);
    expect(task).toBeUndefined();
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toBe(
      `secrets_unmaskable: these secrets are more than a job is given, 512 KiB of value text counting each secret: ${names
        .slice(0, 10)
        .map((n) => `${n} (${size} bytes)`)
        .join(", ")} and 1 more`,
    );
  });
});

describe("the value text a job is given", () => {
  // Ten values of 48 KiB and one of 32 KiB: 512 KiB counting each secret.
  const names = Array.from({ length: 11 }, (_, k) => `S${String(k).padStart(2, "0")}`);

  it("delivers secrets of exactly 512 KiB of value text, and none past it by one byte", async () => {
    const f = await orgRepo();
    const large = linesValue(48 * 1024);
    for (const name of names.slice(0, 10)) await repoSecret(f, name, large);
    const last = await repoSecret(f, "S10", linesValue(32 * 1024));
    const { task } = await delivered(f, dynamic);
    expect(ownSecrets(task)).toEqual({
      ...Object.fromEntries(names.slice(0, 10).map((n) => [n, large])),
      S10: last,
    });
    await repoSecret(f, "S10", linesValue(32 * 1024 + 1));
    const { runId, task: none } = await deliver(f, dynamic);
    expect(none).toBeUndefined();
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(
      /^secrets_unmaskable: these secrets are more than a job is given, 512 KiB of value text/,
    );
    expect(only?.error).toContain(`S00 (${48 * 1024} bytes)`);
  });
});

/**
 * What an assignment by an earlier life of the run's object (since reset) committed before its
 * directory write: an offer to `runner` at `version`, its instance assigned under it and its task
 * mapped. The test lands that write when it chooses, as `RECORD_TASK_SQL`.
 */
async function assignedEarlier(
  f: OrgFixture,
  runId: string,
  runner: RegisteredRunner,
  version: number,
) {
  const { jobId } = await jobA(runId);
  const offer = await env.DIRECTORY.prepare(
    `INSERT INTO ci_tasks (run_id, job_id, runner_id, offered_version, created_at, repo_id, fork)
     VALUES (?, ?, ?, ?, ?, ?, 0) RETURNING id`,
  )
    .bind(runId, jobId, runner.id, version, Date.now(), f.repo.id)
    .first<{ id: number }>();
  if (!offer) throw new Error("no offer");
  const task = await inRun(runId, (r) => {
    const assigned = r.assign(jobId, `t${offer.id}`);
    if (!assigned.ok) throw new Error(assigned.code);
    r.engine.exec(
      "INSERT INTO ci_tasks (wire_id, job_id, task, runner_id) VALUES (?, ?, ?, ?)",
      offer.id,
      jobId,
      assigned.task.task,
      runner.id,
    );
    return assigned.task.task;
  });
  const record = () => env.DIRECTORY.prepare(RECORD_TASK_SQL).bind(task, offer.id).run();
  return { offerId: offer.id, record };
}

describe("a failed delivery and a late record of the same offer", () => {
  it("a record that lands first keeps the job and spends the credential when the task ends", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const version = await primed(f);
    await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    await breakSecret(f, "A");
    const { offerId, record } = await assignedEarlier(f, runId, runner, version);
    let changes: number | undefined;
    await inRun(runId, (r) => {
      r.hooks = {
        beforeDeliveryFailure: async () => {
          changes = (await record()).meta.changes;
        },
      };
    });
    try {
      const refused = await fetchTask(runner, version);
      expect(refused.task).toBeUndefined();
      expect(refused.tasksVersion).toBe(version);
    } finally {
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
    expect(changes).toBe(1);
    expect(await jobA(runId)).toMatchObject({ status: "in_progress" });
    expect(await taskRow(offerId)).toMatchObject({ ended_at: null, superseded_at: null });
    expect((await taskRow(offerId))?.task).not.toBeNull();
    // The earlier life may have answered: the task's end spends the credential.
    await runStub(runId).cancel(f.owner.principalId, "force");
    await drain(runId);
    expect((await credentialOf(runner))?.expires_at).not.toBeNull();
  });

  it("a record that lands after the offer ended for its secrets loses, and spends no credential", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const version = await primed(f);
    await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    await breakSecret(f, "A");
    const { offerId, record } = await assignedEarlier(f, runId, runner, version);
    let changes: number | undefined;
    await inRun(runId, (r) => {
      r.hooks = {
        afterDeliveryFailure: async () => {
          changes = (await record()).meta.changes;
        },
      };
    });
    try {
      expect((await fetchTask(runner, version)).task).toBeUndefined();
    } finally {
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
    expect(changes).toBe(0);
    const offer = await taskRow(offerId);
    expect(offer?.task).toBeNull();
    expect(offer?.ended_at).not.toBeNull();
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(/^secrets_unavailable: /);
    expect(await credentialOf(runner)).toEqual({ expires_at: null, task_confirmed_at: null });
  });

  it("an assignment that died before its directory write leaves a failing re-offer to fail the job", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = {
        beforeTaskRecord: () => {
          if (++calls === 1) throw new Error("the assignment died");
        },
      };
    });
    try {
      await expect(fetchTask(runner, version)).rejects.toThrow();
      expect((await tasksOfRun(runId)).map((t) => t.task)).toEqual([null]);
      await breakSecret(f, "A");
      expect((await fetchTask(runner, version)).task).toBeUndefined();
    } finally {
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
    expect(calls).toBe(1);
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toBe(
      "secrets_unavailable: these secrets do not open with the deployment's CI keys: A",
    );
  });
});

describe("an assignment whose offer was released meanwhile", () => {
  it("puts its job back in the queue, and a later poll is given it", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const version = await primed(f);
    const value = await repoSecret(f, "A");
    const runId = await started(f, reading("A"));
    // The clock stands still, so no poll's deadline passes while the other is held.
    const held = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(held);
    const read = gate();
    let reads = 0;
    accountHooks.ciSecretsRead = async () => {
      if (++reads === 1) {
        await read.hold();
        throw new Error("the account object is unreachable");
      }
    };
    const record = gate();
    await inRun(runId, (r) => {
      r.hooks = { beforeTaskRecord: () => record.hold() };
    });
    const pending: Promise<unknown>[] = [];
    try {
      // The claiming poll is reading the job's secrets.
      const claiming = fetchTask(runner, version);
      pending.push(claiming);
      await reached(read, claiming);
      // The runner's next poll at the same version is offered the same task, reads its secrets,
      // and is about to record it.
      const reoffer = fetchTask(runner, version);
      pending.push(reoffer);
      await reached(record, reoffer);
      expect(await jobA(runId)).toMatchObject({ status: "in_progress" });
      // The claiming poll's read fails: it releases the claim, superseding the offer.
      read.release();
      expect((await claiming).task).toBeUndefined();
      record.release();
      expect((await reoffer).task).toBeUndefined();
    } finally {
      read.release();
      record.release();
      await Promise.allSettled(pending);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
    expect(reads).toBe(2);
    expect(await jobA(runId)).toMatchObject({ status: "queued" });
    vi.setSystemTime(Date.now() + SECRETS_RETRY_MS + 1);
    const task = (await fetchTask(runner, 0)).task;
    expect(task && ownSecrets(task)).toEqual({ A: value });
  });
});

describe("jobs whose account does not answer, polled in turn", () => {
  it("six of them never keep a later job from its turn", async () => {
    const f = await orgRepo();
    await repoSecret(f, "A");
    for (let k = 0; k < 6; k++) await started(f, reading("A"));
    const healthy = await started(f, workflow(job("a")));
    const runner = await registerRunner(f.org.login, f.owner);
    accountHooks.ciSecretsRead = async () => {
      throw new Error("the account object is unreachable");
    };
    const at = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    let given: number | undefined;
    // Polls 6 s apart, each claiming up to three jobs: a released job's 10 s wait lapses
    // between every other poll.
    for (let poll = 0; poll < 8 && given === undefined; poll++) {
      vi.setSystemTime(at + poll * 6_000);
      const task = (await fetchTask(runner, 0)).task;
      if (task) {
        expect((await taskRow(task.id))?.run_id).toBe(healthy);
        given = poll;
      }
    }
    expect(given).toBeDefined();
    expect(given).toBeLessThanOrEqual(2);
  });

  it("a job written again behind the others keeps every column of its row but the id", async () => {
    const { results } = await env.DIRECTORY.prepare("PRAGMA table_info(ci_pending_jobs)").all<{
      name: string;
    }>();
    expect(results.map((c) => c.name).filter((c) => c !== "id")).toEqual([...PENDING_COLUMNS]);
  });
});
