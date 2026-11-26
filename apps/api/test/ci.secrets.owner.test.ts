// Secrets reach a run's jobs only from the account that owned the repository
// when the run was created, and a trigger event starts runs only under the
// owner it was recorded under. A transfer between the two leaves the new
// owner's secrets and variables out of the run: its jobs that read secrets
// fail with `owner_changed`, and an event not yet evaluated closes.
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startRun } from "../src/ci/runs.js";
import { accountHooks } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { advanceTransfer, transferHooks } from "../src/repos/transfer.js";
import { api, json, user } from "./helpers/api.js";
import { newOrg, orgRepoOf, putSecret, secretValue } from "./helpers/ci-secrets.js";
import {
  type CiRepo,
  ciRepo,
  commit,
  eventRunsOf,
  eventsOf,
  runTriggers,
  switchCi,
} from "./helpers/ci-triggers.js";
import { inRepo } from "./helpers/repo-git.js";
import { fetchTask, pendingOf, registerRunner } from "./helpers/runners.js";
import {
  at,
  drain,
  expr,
  inRun,
  job,
  jobNamed,
  jobsOf,
  now,
  specFor,
  T0,
  workflow,
} from "./helpers/runs.js";

const CI = ".github/workflows/ci.yml";
const MIN = 60_000;

beforeAll(() => switchCi(true));
afterAll(() => switchCi(false));

let secretReads = 0;
afterEach(() => {
  secretReads = 0;
  delete accountHooks.ciSecretsRead;
  delete transferHooks.afterGeneration;
});

const reading = workflow(
  job("a", [
    "env:",
    `  O: ${expr("secrets.ORG_SECRET")}`,
    `  R: ${expr("secrets.REPO_SECRET")}`,
    `  V: ${expr("vars.ONLY_B")}`,
  ]),
);

/** POST …/transfer of the repository to `login`, run until it lands. */
async function transferred(f: CiRepo, login: string): Promise<string> {
  const started = await json<{ state: string }>(
    api("POST", `${f.path}/transfer`, f.owner.token, { new_owner: login }),
  );
  expect(started.status).toBeLessThan(300);
  if (started.body.state !== "transferred")
    expect(await advanceTransfer(env, f.repo.id)).toMatchObject({ state: "transferred" });
  return `/repos/${login}/${f.repo.name}`;
}

/** The new owner's secrets (and a variable) every repository of it may read. */
async function newOwnerSecrets(f: CiRepo, login: string, path: string) {
  const values = { org: secretValue(), repo: secretValue() };
  expect(
    (await putSecret(f.owner, `/orgs/${login}`, "ORG_SECRET", values.org, { visibility: "all" }))
      .status,
  ).toBeLessThan(300);
  expect((await putSecret(f.owner, path, "REPO_SECRET", values.repo)).status).toBeLessThan(300);
  expect(
    (
      await api("POST", `/orgs/${login}/actions/variables`, f.owner.token, {
        name: "ONLY_B",
        value: "b",
        visibility: "all",
      })
    ).status,
  ).toBe(201);
  return values;
}

/** The repository object's clock, frozen; the returned function moves it past any retry. */
async function frozen(f: CiRepo) {
  const clock = { now: Date.now() };
  await inRepo(f.stub, (r: RepoDO) => {
    (r.git.context as { now: () => number }).now = () => clock.now;
  });
  return () => {
    clock.now += 60 * 60_000;
  };
}

describe("a run created before its repository moved to another account", () => {
  it("never hands its jobs the new account's secrets: the job fails with owner_changed", async () => {
    const f = await ciRepo({ [CI]: reading });
    await runTriggers(f.stub);
    const [allocated] = await eventRunsOf(f.stub);
    const runId = allocated?.run_id as string;
    expect(allocated).toMatchObject({ outcome: null });
    expect(allocated?.started_at).not.toBeNull();
    await at(runId, T0);
    await drain(runId);
    expect((await pendingOf(runId))[0]?.account_id).toBe(f.owner.principalId);

    const org = await newOrg(await user(true), f.owner);
    const path = await transferred(f, org.login);
    const values = await newOwnerSecrets(f, org.login, path);
    // The run follows the transfer: its queued job is published to the new account.
    await at(runId, now(runId) + 5 * MIN);
    await drain(runId);
    expect((await pendingOf(runId))[0]?.account_id).toBe(org.id);

    accountHooks.ciSecretsRead = async () => {
      secretReads++;
    };
    const runner = await registerRunner(org.login, f.owner);
    const { task } = await fetchTask(runner, 0);
    for (const value of [...(task?.secrets.values() ?? [])])
      expect([values.org, values.repo]).not.toContain(value);
    expect(task).toBeUndefined();
    expect(secretReads).toBe(0);
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(/^owner_changed: /);
  });
});

describe("a run bound to no owner", () => {
  async function orgCiRepo() {
    const owner = await user();
    const org = await newOrg(await user(true), owner);
    const repo = await orgRepoOf(owner, org.login);
    const f: CiRepo = {
      owner,
      repo,
      path: `/repos/${org.login}/${repo.name}`,
      stub: env.REPO.getByName(repo.id),
    };
    const values = await newOwnerSecrets(f, org.login, f.path);
    return { f, org, values };
  }

  /** Has a new runner of `org` fetch; the job must end `owner_changed`, the account never asked. */
  async function expectOwnerChanged(runId: string, org: { login: string }, f: CiRepo) {
    await at(runId, T0);
    await drain(runId);
    expect(await inRun(runId, (r) => r.engine.run()?.owner_id)).toBeNull();
    accountHooks.ciSecretsRead = async () => {
      secretReads++;
    };
    const runner = await registerRunner(org.login, f.owner);
    const { task } = await fetchTask(runner, 0);
    expect(task).toBeUndefined();
    expect(secretReads).toBe(0);
    await drain(runId);
    const [only] = await jobsOf(runId);
    expect(only).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(only?.error).toMatch(/^owner_changed: /);
  }

  it("created with no owner, is given no secret: its job fails with owner_changed", async () => {
    const { f, org } = await orgCiRepo();
    const sha = await commit(f, "main", { "b.txt": "b\n" });
    const spec = specFor({ ...f, sha }, reading);
    expect(await startRun(env, spec)).toMatchObject({ ok: true });
    await expectOwnerChanged(spec.runId, org, f);
  });

  it("started from an allocation an earlier version stored, is given no secret", async () => {
    const { f, org } = await orgCiRepo();
    await commit(f, "main", { [CI]: reading });
    let fail = true;
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeStart: () => {
          if (fail) {
            fail = false;
            throw new Error("the run object could not be reached");
          }
        },
      };
    });
    const later = await frozen(f);
    await runTriggers(f.stub);
    const [allocated] = await eventRunsOf(f.stub);
    expect(allocated).toMatchObject({ started_at: null });
    // As an earlier version stored it: without the owner it was built under.
    await inRepo(f.stub, (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "UPDATE ci_run_specs SET spec = json_remove(spec, '$.snapshotOwner')",
      );
    });
    later();
    await runTriggers(f.stub);
    const [started] = await eventRunsOf(f.stub);
    expect(started?.started_at).not.toBeNull();
    await expectOwnerChanged(started?.run_id as string, org, f);
  });
});

describe("the job token's names", () => {
  const tokenOnly = workflow(job("a", ["env:", `  T: ${expr("secrets.GITHUB_TOKEN")}`]));

  it("are no secret: a moved run's job that reads only GITHUB_TOKEN is given its task and token", async () => {
    const f = await ciRepo({ [CI]: tokenOnly });
    await runTriggers(f.stub);
    const runId = (await eventRunsOf(f.stub))[0]?.run_id as string;
    await at(runId, T0);
    await drain(runId);
    const org = await newOrg(await user(true), f.owner);
    await transferred(f, org.login);
    await at(runId, now(runId) + 5 * MIN);
    await drain(runId);
    accountHooks.ciSecretsRead = async () => {
      secretReads++;
    };
    const runner = await registerRunner(org.login, f.owner);
    const { task } = await fetchTask(runner, 0);
    expect(task?.secrets.get("GITHUB_TOKEN")).toMatch(/^fyrden_job_/);
    expect(secretReads).toBe(0);
  });

  it("are not asked of the account beside a real secret", async () => {
    const owner = await user();
    const org = await newOrg(await user(true), owner);
    const repo = await orgRepoOf(owner, org.login);
    const f: CiRepo = {
      owner,
      repo,
      path: `/repos/${org.login}/${repo.name}`,
      stub: env.REPO.getByName(repo.id),
    };
    const values = await newOwnerSecrets(f, org.login, f.path);
    await commit(f, "main", {
      [CI]: workflow(
        job("a", [
          "env:",
          `  T: ${expr("secrets.GITHUB_TOKEN")}`,
          `  G: ${expr("secrets['gitea_token']")}`,
          `  R: ${expr("secrets.REPO_SECRET")}`,
        ]),
      ),
    });
    await runTriggers(f.stub);
    const runId = (await eventRunsOf(f.stub))[0]?.run_id as string;
    await at(runId, T0);
    await drain(runId);
    const { jobId } = await jobNamed(runId, "a");
    expect(await inRun(runId, (r) => r.secretsRequest(jobId)?.refs)).toEqual({
      kind: "names",
      names: ["REPO_SECRET"],
    });
    const runner = await registerRunner(org.login, owner);
    const { task } = await fetchTask(runner, 0);
    expect(task?.secrets.get("REPO_SECRET")).toBe(values.repo);
    expect(task?.secrets.get("GITHUB_TOKEN")).toMatch(/^fyrden_job_/);
  });
});

describe("a run of the account that owns its repository", () => {
  it("is bound to that account, and its jobs get that account's secrets", async () => {
    const owner = await user();
    const org = await newOrg(await user(true), owner);
    const repo = await orgRepoOf(owner, org.login);
    const f: CiRepo = {
      owner,
      repo,
      path: `/repos/${org.login}/${repo.name}`,
      stub: env.REPO.getByName(repo.id),
    };
    const values = await newOwnerSecrets(f, org.login, f.path);
    await commit(f, "main", { [CI]: reading });
    await runTriggers(f.stub);
    const runId = (await eventRunsOf(f.stub))[0]?.run_id as string;
    expect(await inRun(runId, (r) => r.engine.run()?.owner_id)).toBe(org.id);
    await at(runId, T0);
    await drain(runId);
    const runner = await registerRunner(org.login, owner);
    const { task } = await fetchTask(runner, 0);
    expect(task?.secrets.get("ORG_SECRET")).toBe(values.org);
    expect(task?.secrets.get("REPO_SECRET")).toBe(values.repo);
    expect(task?.vars.get("ONLY_B")).toBe("b");
  });
});

describe("a trigger event recorded before its repository moved to another account", () => {
  it("starts no run under the new account: it waits while the transfer moves, then closes", async () => {
    // The push of the workflow records the event; the trigger job has not run it yet.
    const f = await ciRepo({ [CI]: reading });
    const later = await frozen(f);
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "pending" }]);
    const org = await newOrg(await user(true), f.owner);
    transferHooks.afterGeneration = () => Promise.reject(new Error("held before landing"));
    const moving = await json<{ state: string }>(
      api("POST", `${f.path}/transfer`, f.owner.token, { new_owner: org.login }),
    );
    expect(moving.body).toMatchObject({ state: "transferring" });
    delete transferHooks.afterGeneration;
    // While it moves, the event waits, its names unread.
    await runTriggers(f.stub);
    const [waiting] = await eventsOf(f.stub);
    expect(waiting).toMatchObject({ kind: "push", state: "pending" });
    expect(JSON.parse(waiting?.resolved ?? "{}").names).toBeUndefined();
    expect(await eventRunsOf(f.stub)).toEqual([]);
    // Landed under the organization, whose secrets and variables the run would read.
    expect(await advanceTransfer(env, f.repo.id)).toMatchObject({ state: "transferred" });
    await newOwnerSecrets(f, org.login, `/repos/${org.login}/${f.repo.name}`);
    later();
    await runTriggers(f.stub);
    expect(await eventsOf(f.stub)).toMatchObject([
      { kind: "push", state: "done", outcome: "owner_changed" },
    ]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("recorded by an earlier version, without its owner, closes at its first evaluation after a transfer", async () => {
    const f = await ciRepo({ [CI]: reading });
    await inRepo(f.stub, (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "UPDATE ci_events SET facts = json_remove(facts, '$.recorded_owner') WHERE state = 'pending'",
      );
    });
    const org = await newOrg(await user(true), f.owner);
    const path = await transferred(f, org.login);
    await newOwnerSecrets(f, org.login, path);
    const asked: string[] = [];
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: {
          getByName: (name: string) => ({
            ciVariablesFor: (repoId: string) => {
              asked.push(repoId);
              return env.ORG.getByName(name).ciVariablesFor(repoId);
            },
          }),
        } as unknown as typeof env.ORG,
      };
    });
    await runTriggers(f.stub);
    expect(await eventsOf(f.stub)).toMatchObject([
      { kind: "push", state: "done", outcome: "owner_changed" },
    ]);
    expect(asked).toEqual([]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("evaluated first after the transfer landed, closes without a run", async () => {
    const f = await ciRepo({ [CI]: reading });
    const org = await newOrg(await user(true), f.owner);
    const path = await transferred(f, org.login);
    await newOwnerSecrets(f, org.login, path);
    await runTriggers(f.stub);
    expect(await eventsOf(f.stub)).toMatchObject([
      { kind: "push", state: "done", outcome: "owner_changed" },
    ]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("recorded and run under the same owner starts its run", async () => {
    const f = await ciRepo({ [CI]: reading });
    await runTriggers(f.stub);
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "done" }]);
    expect(await eventRunsOf(f.stub)).toMatchObject([{ outcome: null }]);
  });
});
