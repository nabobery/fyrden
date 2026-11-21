// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests write workflow expressions, `${{ }}` included, as plain strings
// Variables are a snapshot taken when the trigger builds a run's spec: the
// repository's own over the organization's that reach it, within 256 KB,
// for trusted runs only, persisted with the spec so a retry, a re-run and an
// approval all read the same values. Plan-time expressions (`runs-on`, a
// job's `if`) read that snapshot, as `run-name` does when evaluated here
// from the stored contexts. Contexts whose JSON encoding, measured with the
// run's own number, passes the limit fail the run as `variables_too_large`.
// A run allocated under the former owner of a transferred repository is
// dropped at its first registration.
import { env, exports } from "cloudflare:workers";
import { evaluateField, toExprString } from "@fyrden/domain/ci";
import { uniqueId } from "@fyrden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { MAX_VARIABLES_REFUSALS } from "../src/do/repo/ci-triggers.js";
import { exprFromJson } from "../src/do/run/codec.js";
import { loadModel } from "../src/do/run/model.js";
import {
  MAX_RUN_CONTEXTS_BYTES,
  type RunSpec,
  snapshotVariables,
  validateRunSpec,
} from "../src/do/run/spec.js";
import { dispatchHooks } from "../src/repos/runs.js";
import { advanceTransfer, transferHooks } from "../src/repos/transfer.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { inAccount, newOrg, orgRepoOf } from "./helpers/ci-secrets.js";
import {
  type CiRepo,
  ciRepo,
  commit,
  eventRunsOf,
  eventsOf,
  pushRefs,
  runTriggers,
  switchCi,
  viewOf,
} from "./helpers/ci-triggers.js";
import { ORIGIN } from "./helpers/git-http.js";
import { ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  at,
  drain,
  finish,
  inRun,
  jobsOf,
  repoWithCommit,
  runStub,
  specFor,
  T0,
} from "./helpers/runs.js";
import { logs } from "./setup/log-capture.js";

const CI = ".github/workflows/ci.yml";

beforeAll(() => switchCi(true));
afterAll(() => switchCi(false));

/** A workflow whose run name, job `if` and `runs-on` read variables. */
function varsWorkflow(on: string): string {
  return [
    "name: ci",
    "run-name: ${{ vars.TITLE }}",
    `on: ${on}`,
    "jobs:",
    "  build:",
    "    if: vars.GO == 'yes'",
    "    runs-on: ${{ vars.LABEL }}",
    "    steps:",
    "      - run: echo hi",
    "",
  ].join("\n");
}

const PLAN_VARS = { GO: "yes", LABEL: "vars-label", TITLE: "titled by vars" };

async function setVariable(who: Who, path: string, name: string, value: string, extra = {}) {
  const made = await api("POST", `${path}/actions/variables`, who.token, {
    name,
    value,
    ...extra,
  });
  expect(made.status).toBe(201);
}

async function changeVariable(who: Who, path: string, name: string, value: string) {
  expect(
    (await api("PATCH", `${path}/actions/variables/${name}`, who.token, { name, value })).status,
  ).toBe(204);
}

async function setVariables(who: Who, path: string, vars: Record<string, string>) {
  for (const [name, value] of Object.entries(vars)) await setVariable(who, path, name, value);
}

/** The variables the run was created with. */
const varsOf = (runId: string) =>
  inRun(
    runId,
    (r) =>
      JSON.parse((r.engine.run() as { contexts: string }).contexts).vars as Record<string, string>,
  );

/** The run's `run-name`, evaluated from its stored contexts. */
const runNameOf = (runId: string) =>
  inRun(runId, (r) => {
    const run = r.engine.run() as {
      workflow_path: string;
      workflow_source: string;
      contexts: string;
    };
    const loaded = loadModel(run.workflow_path, run.workflow_source);
    const field = loaded.ok ? loaded.model.fields.get("run-name") : undefined;
    if (!field) throw new Error("no run-name");
    const contexts = JSON.parse(run.contexts);
    const value = evaluateField(field, {
      github: exprFromJson(contexts.github),
      inputs: exprFromJson(contexts.inputs),
      vars: exprFromJson(contexts.vars),
    });
    if (!value.ok) throw new Error(value.error.message);
    return toExprString(value.value);
  });

/** What planning made of the run's current attempt: the runs-on of each queued job, each job's state. */
async function planOf(runId: string) {
  await at(runId, T0);
  await drain(runId);
  const view = await viewOf(runId);
  return {
    runsOn: (await runStub(runId).queued()).map((q) => q.runsOn),
    jobs: (await jobsOf(runId, view.attempt)).map((j) => ({
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
    })),
  };
}

/** Everything a run read from its variables. */
async function readVars(runId: string) {
  return { vars: await varsOf(runId), title: await runNameOf(runId), ...(await planOf(runId)) };
}

const READ_PLAN_VARS = {
  vars: PLAN_VARS,
  title: PLAN_VARS.TITLE,
  runsOn: [["vars-label"]],
  jobs: [{ name: "build", status: "queued", conclusion: null }],
};

async function onlyRun(f: CiRepo, kind: string): Promise<string> {
  const runs = (await eventRunsOf(f.stub)).filter((r) => r.trigger_kind === kind);
  expect(runs).toHaveLength(1);
  return (runs[0] as { run_id: string }).run_id;
}

/** A repository of `owner` whose first commit holds a vars workflow for `on`, and its variables. */
async function varsRepo(on: string, vars: Record<string, string> = PLAN_VARS) {
  const f = await ciRepo({ [CI]: varsWorkflow(on), "a.txt": "one\n" });
  await setVariables(f.owner, f.path, vars);
  return f;
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

describe("the variables a run's plan reads", () => {
  it("are the repository's, for a push", async () => {
    const f = await varsRepo("push");
    await runTriggers(f.stub);
    expect(await readVars(await onlyRun(f, "push"))).toEqual(READ_PLAN_VARS);
  });

  it("are the repository's, for a pull request from a branch", async () => {
    const f = await varsRepo("pull_request");
    await runTriggers(f.stub);
    const main = await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token));
    expect(
      await pushRefs(f, [{ old: ZERO, new: main.body.sha, ref: "refs/heads/feature" }]),
    ).toContain("ok refs/heads/feature");
    await commit(f, "feature", { "c.txt": "c\n" });
    expect(
      (
        await api("POST", `${f.path}/pulls`, f.owner.token, {
          title: "A change",
          head: "feature",
          base: "main",
        })
      ).status,
    ).toBe(201);
    await runTriggers(f.stub);
    const runId = await onlyRun(f, "pull_request");
    expect(await viewOf(runId)).toMatchObject({ trust: "trusted", fork: false });
    expect(await readVars(runId)).toEqual(READ_PLAN_VARS);
  });

  it("are the repository's, for a schedule", async () => {
    const f = await varsRepo("\n  schedule:\n    - cron: '0 * * * *'");
    await runTriggers(f.stub);
    await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.transactionSync(() =>
        r.ciTriggers.recordSchedule(uniqueId("tick"), f.owner.principalId, {
          path: CI,
          cron: "0 * * * *",
          tick: r.git.context.now(),
        }),
      ),
    );
    await runTriggers(f.stub);
    expect(await readVars(await onlyRun(f, "schedule"))).toEqual(READ_PLAN_VARS);
  });

  it("are the repository's, for a dispatch", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const answer = await dispatch(f);
    expect(answer.status).toBe(200);
    expect(await readVars(answer.body.workflow_run_id as string)).toEqual(READ_PLAN_VARS);
  });

  it("are the repository's over the organization's that reach it", async () => {
    const admin = await user(true);
    const owner = await user();
    const org = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, org.login, "public");
    const other = await orgRepoOf(owner, org.login, "private");
    const orgPath = `/orgs/${org.login}`;
    const path = `/repos/${org.login}/${repo.name}`;
    await setVariable(owner, orgPath, "SHARED", "org", { visibility: "all" });
    await setVariable(owner, orgPath, "ORG_ONLY", "o", { visibility: "all" });
    await setVariable(owner, orgPath, "PRIV", "p", { visibility: "private" });
    await setVariable(owner, orgPath, "SEL", "s", {
      visibility: "selected",
      selected_repository_ids: [other.id],
    });
    await setVariable(owner, orgPath, "MINE", "m", {
      visibility: "selected",
      selected_repository_ids: [repo.id],
    });
    await setVariable(owner, path, "shared", "repo");
    await commit({ path, owner }, "main", { [CI]: varsWorkflow("push") });
    const f: CiRepo = { owner, repo, path, stub: env.REPO.getByName(repo.id) };
    await runTriggers(f.stub);
    expect(await varsOf(await onlyRun(f, "push"))).toEqual({
      MINE: "m",
      ORG_ONLY: "o",
      SHARED: "repo",
    });
  });
});

describe("fork pull requests", () => {
  /** A base with a workflow on both pull request events, and a first-time contributor's fork pull request. */
  async function forkPull() {
    const base = await varsRepo("[pull_request, pull_request_target]");
    await runTriggers(base.stub);
    const writer = await user();
    const contributor = await user();
    for (const [who, role] of [
      [writer, "push"],
      [contributor, "pull"],
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
    const forkPath = `/repos/${contributor.handle}/${forked.body.name}`;
    await commit({ path: forkPath, owner: contributor }, "main", { "b.txt": "fork\n" });
    expect(
      (
        await api("POST", `${base.path}/pulls`, contributor.token, {
          title: "From a fork",
          head: `${contributor.handle}:main`,
          base: "main",
        })
      ).status,
    ).toBe(201);
    return { base, writer };
  }

  it("give a fork's pull_request run no variables, without asking for them", async () => {
    const { base } = await forkPull();
    const asked: string[] = [];
    await inRepo(base.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: countingOrg(asked),
      };
    });
    await runTriggers(base.stub);
    const untrusted = await onlyRun(base, "pull_request");
    expect(await viewOf(untrusted)).toMatchObject({ trust: "untrusted", fork: true });
    expect(await varsOf(untrusted)).toEqual({});
    expect(await runNameOf(untrusted)).toBe("");
    // The trusted pull_request_target run alone asked.
    expect(asked).toEqual([base.repo.id]);
  });

  it("give an approval-held pull_request_target run its snapshot, read once it is approved", async () => {
    const { base, writer } = await forkPull();
    await runTriggers(base.stub);
    const held = await onlyRun(base, "pull_request_target");
    expect(await viewOf(held)).toMatchObject({
      trust: "trusted",
      fork: true,
      approval: { state: "waiting" },
    });
    expect(await varsOf(held)).toEqual(PLAN_VARS);
    // A change after the run was created does not reach it.
    await changeVariable(base.owner, base.path, "LABEL", "changed");
    const approved = await api(
      "POST",
      `${base.path}/actions/runs/${held}/approve`,
      writer.token,
      {},
    );
    expect(approved.status).toBe(201);
    expect(await readVars(held)).toEqual(READ_PLAN_VARS);
  });
});

describe("the snapshot", () => {
  it("is persisted with the run's spec: a retried start reads no variable again", async () => {
    const f = await varsRepo("push");
    const later = await frozen(f);
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
    await runTriggers(f.stub);
    const [allocated] = await eventRunsOf(f.stub);
    expect(allocated?.started_at).toBeNull();
    const stored = await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ spec: string }>("SELECT spec FROM ci_run_specs WHERE run_id = ?", allocated?.run_id)
        .one(),
    );
    expect((JSON.parse(stored.spec) as RunSpec).vars).toEqual(PLAN_VARS);
    await changeVariable(f.owner, f.path, "LABEL", "changed");
    later();
    await runTriggers(f.stub);
    const runId = await onlyRun(f, "push");
    expect(runId).toBe(allocated?.run_id);
    expect(await readVars(runId)).toEqual(READ_PLAN_VARS);
  });

  it("is retried, never left out, when the account object cannot answer", async () => {
    const f = await varsRepo("push");
    const later = await frozen(f);
    const asked: string[] = [];
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: countingOrg(asked, 1),
      };
    });
    await runTriggers(f.stub);
    expect(asked).toEqual([f.repo.id]);
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "pending" }]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
    later();
    await runTriggers(f.stub);
    expect(asked).toEqual([f.repo.id, f.repo.id]);
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "done" }]);
    expect(await readVars(await onlyRun(f, "push"))).toEqual(READ_PLAN_VARS);
  });

  it("is retried when the account no longer holds the repository", async () => {
    const f = await varsRepo("push");
    const later = await frozen(f);
    const asked: string[] = [];
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: countingOrg(asked, 0, 1),
      };
    });
    await runTriggers(f.stub);
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "pending" }]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
    later();
    await runTriggers(f.stub);
    expect(await varsOf(await onlyRun(f, "push"))).toEqual(PLAN_VARS);
  });

  it("answers a dispatch busy, recording nothing, when the account object cannot answer", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const asked: string[] = [];
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: countingOrg(asked, 1),
      };
    });
    const key = uniqueId("key");
    expect(await dispatch(f, key)).toMatchObject({ status: 503, body: { code: "busy" } });
    expect(await eventRunsOf(f.stub)).toEqual([]);
    const answer = await dispatch(f, key);
    expect(answer.status).toBe(200);
    expect(await varsOf(answer.body.workflow_run_id as string)).toEqual(PLAN_VARS);
  });

  it("never reaches a run registered after a transfer: the allocation under the former owner is dropped", async () => {
    const f = await varsRepo("push");
    const later = await frozen(f);
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
    // Allocated under the user, with the user's variables, and not started.
    await runTriggers(f.stub);
    const [allocated] = await eventRunsOf(f.stub);
    expect(allocated).toMatchObject({ started_at: null, outcome: null });
    const runId = allocated?.run_id as string;
    expect((JSON.parse((await storedSpec(f, runId)) as string) as RunSpec).vars).toEqual(PLAN_VARS);
    // A transfer to an organization moves the repository, and holds before it lands.
    const org = await newOrg(await user(true), f.owner);
    transferHooks.afterGeneration = () => Promise.reject(new Error("held before landing"));
    try {
      expect(await transferTo(f, org.login)).toMatchObject({ body: { state: "transferring" } });
    } finally {
      delete transferHooks.afterGeneration;
    }
    // The registration is refused while it moves: the run waits, unstarted.
    later();
    await runTriggers(f.stub);
    expect(await eventRunsOf(f.stub)).toMatchObject([
      { run_id: runId, started_at: null, outcome: null },
    ]);
    expect(await registeredRuns(f)).toEqual([]);
    // It lands; the allocation made under the user is dropped, never started under the organization.
    expect(await advanceTransfer(env, f.repo.id)).toMatchObject({ state: "transferred" });
    later();
    await runTriggers(f.stub);
    expect(await eventRunsOf(f.stub)).toMatchObject([
      { run_id: runId, started_at: null, outcome: "owner_changed" },
    ]);
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "done" }]);
    expect(await storedSpec(f, runId)).toBeNull();
    expect(await registeredRuns(f)).toEqual([]);
    expect(await inRun(runId, (r) => r.engine.run() ?? null)).toBeNull();
  });

  it("closes an event whose owner a transfer changed before its variables were read", async () => {
    const f = await varsRepo("push");
    const later = await frozen(f);
    const asked: string[] = [];
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: countingOrg(asked, 1),
      };
    });
    // The event's names (its owner, the user) are kept; its variables could not be read.
    await runTriggers(f.stub);
    expect(asked).toEqual([f.repo.id]);
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "pending" }]);
    const org = await newOrg(await user(true), f.owner);
    transferHooks.afterGeneration = () => Promise.reject(new Error("held before landing"));
    try {
      expect(await transferTo(f, org.login)).toMatchObject({ body: { state: "transferring" } });
    } finally {
      delete transferHooks.afterGeneration;
    }
    // The user let the repository go; while the transfer moves it, the event waits, and no
    // account is asked for its variables.
    later();
    await runTriggers(f.stub);
    expect(asked).toHaveLength(1);
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "pending" }]);
    // Landed in another account: the event is closed, nothing allocated or asked.
    expect(await advanceTransfer(env, f.repo.id)).toMatchObject({ state: "transferred" });
    later();
    await runTriggers(f.stub);
    expect(asked).toHaveLength(1);
    expect(await eventsOf(f.stub)).toMatchObject([
      { kind: "push", state: "done", outcome: "owner_changed" },
    ]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("closes an event an earlier version recorded without its owner, reading no variables, though nothing moved", async () => {
    const f = await varsRepo("push");
    await withoutRecordedOwner(f);
    const asked: string[] = [];
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: countingOrg(asked),
      };
    });
    await runTriggers(f.stub);
    expect(asked).toEqual([]);
    expect(await eventsOf(f.stub)).toMatchObject([
      { kind: "push", state: "done", outcome: "owner_changed" },
    ]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("closes an event refused with no transfer under way after a bounded number of attempts", async () => {
    const f = await varsRepo("push");
    const later = await frozen(f);
    const asked: string[] = [];
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: countingOrg(asked, 0, Number.MAX_SAFE_INTEGER),
      };
    });
    // The same owner, the same generation, nothing moving: retried, but not forever.
    for (let i = 1; i < MAX_VARIABLES_REFUSALS; i++) {
      await runTriggers(f.stub);
      expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "pending" }]);
      later();
    }
    await runTriggers(f.stub);
    expect(asked).toHaveLength(MAX_VARIABLES_REFUSALS);
    const [event] = await eventsOf(f.stub);
    expect(event).toMatchObject({ kind: "push", state: "done", outcome: "variables_refused" });
    expect(await eventRunsOf(f.stub)).toEqual([]);
    expect(
      logs
        .entries()
        .filter(
          (e) => e.level === "error" && e.msg === "a CI event's variables kept being refused",
        ),
    ).toMatchObject([{ event: (event as { id: number }).id, repoId: f.repo.id }]);
  });

  it("keeps retrying an event while a transfer moves the repository, however often", async () => {
    const f = await varsRepo("push");
    const later = await frozen(f);
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: countingOrg([], 0, Number.MAX_SAFE_INTEGER),
      };
    });
    const org = await newOrg(await user(true), f.owner);
    transferHooks.afterGeneration = () => Promise.reject(new Error("held before landing"));
    try {
      expect(await transferTo(f, org.login)).toMatchObject({ body: { state: "transferring" } });
    } finally {
      delete transferHooks.afterGeneration;
    }
    for (let i = 0; i <= MAX_VARIABLES_REFUSALS; i++) {
      await runTriggers(f.stub);
      later();
    }
    expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "pending" }]);
  });

  it("refuses a dispatch, allocating nothing, when a transfer lands while its workflow is read", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const org = await newOrg(await user(true), f.owner);
    const moved: { state?: string } = {};
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeRead: async () => {
          if (moved.state) return;
          moved.state = "moving";
          moved.state = (await transferTo(f, org.login)).body.state;
        },
      };
    });
    expect(await dispatch(f)).toMatchObject({ status: 409, body: { code: "repo_transferring" } });
    expect(moved.state).toBe("transferred");
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch")).toEqual([]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
    expect(await registeredRuns(f)).toEqual([]);
  });

  it("refuses a dispatch when a transfer away and back runs while its workflow is read", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const org = await newOrg(await user(true), f.owner);
    const moved: { states: string[] } = { states: [] };
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeRead: async () => {
          if (moved.states.length) return;
          moved.states.push((await transferTo(f, org.login)).body.state);
          const back = await json<{ state: string }>(
            api("POST", `/repos/${org.login}/${f.repo.name}/transfer`, f.owner.token, {
              new_owner: f.owner.handle,
            }),
          );
          moved.states.push(back.body.state);
        },
      };
    });
    // The same owner as authorized, but another ownership: its variables were never asked for.
    expect(await dispatch(f)).toMatchObject({ status: 409, body: { code: "repo_transferring" } });
    expect(moved.states).toEqual(["transferred", "transferred"]);
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch")).toEqual([]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("refuses a dispatch authorized while a transfer moved the repository, though it lands before the dispatch", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const org = await newOrg(await user(true), f.owner);
    const keeper = await user();
    expect(
      (
        await api("PUT", `/orgs/${org.login}/memberships/${keeper.handle}`, f.owner.token, {
          role: "admin",
        })
      ).status,
    ).toBe(200);
    // Moved in the directory, not landed: the repository still decides access as the user's.
    transferHooks.afterGeneration = () => Promise.reject(new Error("held before landing"));
    try {
      expect(await transferTo(f, org.login)).toMatchObject({ body: { state: "transferring" } });
    } finally {
      delete transferHooks.afterGeneration;
    }
    // The caller has no access at the destination.
    expect(
      (await api("DELETE", `/orgs/${org.login}/memberships/${f.owner.handle}`, keeper.token))
        .status,
    ).toBe(200);
    const landed: { state?: string } = {};
    dispatchHooks.afterAuthorize = async () => {
      delete dispatchHooks.afterAuthorize;
      landed.state = (await advanceTransfer(env, f.repo.id)).state;
    };
    try {
      expect(await dispatch({ ...f, path: `/repos/${org.login}/${f.repo.name}` })).toMatchObject({
        status: 409,
        body: { code: "repo_transferring" },
      });
    } finally {
      delete dispatchHooks.afterAuthorize;
    }
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch")).toEqual([]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
    expect(await registeredRuns(f)).toEqual([]);
    // Refused at the first ownership read: the transfer never had to land.
    expect(landed.state).toBeUndefined();
  });

  it("refuses a dispatch when the directory renames the repository before the call, whatever the repository object knows yet", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    // A rename the directory committed after the decision; the repository object not told yet.
    dispatchHooks.afterAuthorize = async () => {
      delete dispatchHooks.afterAuthorize;
      await env.DIRECTORY.prepare("UPDATE repos SET name_gen = name_gen + 1 WHERE id = ?")
        .bind(f.repo.id)
        .run();
    };
    try {
      expect(await dispatch(f)).toMatchObject({
        status: 409,
        body: { code: "repo_transferring" },
      });
    } finally {
      delete dispatchHooks.afterAuthorize;
    }
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch")).toEqual([]);
  });

  it("refuses a dispatch authorized while ownership was settled, when a transfer starts before the call", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const org = await newOrg(await user(true), f.owner);
    let ran = false;
    // A transfer recorded in the directory after the decision, before the repository freezes.
    dispatchHooks.afterAuthorize = async () => {
      delete dispatchHooks.afterAuthorize;
      ran = true;
      await env.DIRECTORY.prepare(
        `INSERT INTO repo_transfers (repo_id, transfer_id, from_owner, from_name, to_owner, to_name,
           step, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'freeze', ?, 1, 1)`,
      )
        .bind(
          f.repo.id,
          uniqueId("trf"),
          f.owner.principalId,
          f.repo.name,
          org.id,
          f.repo.name,
          f.owner.principalId,
        )
        .run();
    };
    try {
      expect(await dispatch(f)).toMatchObject({
        status: 409,
        body: { code: "repo_transferring" },
      });
    } finally {
      delete dispatchHooks.afterAuthorize;
    }
    expect(ran).toBe(true);
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch")).toEqual([]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
    expect(await registeredRuns(f)).toEqual([]);
  });

  it("refuses a dispatch, not busy, when a transfer lands while its variables are read", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const org = await newOrg(await user(true), f.owner);
    const moved: { state?: string } = {};
    // The transfer lands while the user's account is asked; the account then refuses.
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: {
          getByName: (name: string) => ({
            ciVariablesFor: async (repoId: string) => {
              moved.state = (await transferTo(f, org.login)).body.state;
              return env.ORG.getByName(name).ciVariablesFor(repoId);
            },
          }),
        } as unknown as DurableObjectNamespace<OrgDO>,
      };
    });
    expect(await dispatch(f)).toMatchObject({ status: 409, body: { code: "repo_transferring" } });
    expect(moved.state).toBe("transferred");
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch")).toEqual([]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("refuses a dispatch, not busy, when the account cannot answer while a transfer moves the repository", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const org = await newOrg(await user(true), f.owner);
    const moved: { state?: string } = {};
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        DIRECTORY: env.DIRECTORY,
        ORG: {
          getByName: () => ({
            ciVariablesFor: async () => {
              transferHooks.afterGeneration = () =>
                Promise.reject(new Error("held before landing"));
              try {
                moved.state = (await transferTo(f, org.login)).body.state;
              } finally {
                delete transferHooks.afterGeneration;
              }
              throw new Error("the account object could not be reached");
            },
          }),
        } as unknown as DurableObjectNamespace<OrgDO>,
      };
    });
    expect(await dispatch(f)).toMatchObject({ status: 409, body: { code: "repo_transferring" } });
    expect(moved.state).toBe("transferring");
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch")).toEqual([]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("answers a dispatch owner_changed when its run, allocated under the former owner, is dropped at once", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const org = await newOrg(await user(true), f.owner);
    const moved: { state?: string } = {};
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeStart: async () => {
          if (moved.state) return;
          moved.state = "moving";
          moved.state = (await transferTo(f, org.login)).body.state;
        },
      };
    });
    const key = uniqueId("key");
    expect(await dispatch(f, key)).toMatchObject({ status: 409, body: { code: "owner_changed" } });
    expect(moved.state).toBe("transferred");
    expect(await eventRunsOf(f.stub)).toMatchObject([{ outcome: "owner_changed" }]);
    expect(await registeredRuns(f)).toEqual([]);
    // The repository asked again under the same key answers the same, never the dropped run.
    expect(await dispatchAgain(f)).toEqual({ ok: false, code: "owner_changed" });
  });

  it("lets a dispatch acknowledged while pending, then dropped, be found out", async () => {
    const f = await varsRepo("workflow_dispatch");
    await runTriggers(f.stub);
    const later = await frozen(f);
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
    const key = uniqueId("key");
    const answer = await dispatch(f, key);
    expect(answer.status).toBe(200);
    const runId = answer.body.workflow_run_id as string;
    const org = await newOrg(await user(true), f.owner);
    expect(await transferTo(f, org.login)).toMatchObject({ body: { state: "transferred" } });
    later();
    await runTriggers(f.stub);
    expect(await eventRunsOf(f.stub)).toMatchObject([{ run_id: runId, outcome: "owner_changed" }]);
    // The run is never created: looking it up answers 404 at its new path.
    expect(
      await json(
        api("GET", `/repos/${org.login}/${f.repo.name}/actions/runs/${runId}`, f.owner.token),
      ),
    ).toMatchObject({ status: 404, body: { code: "run_not_found" } });
    // The repository asked again under the same key answers that it was dropped.
    expect(await dispatchAgain(f)).toEqual({ ok: false, code: "owner_changed" });
  });

  it("is what a re-run reads, whatever changed since", async () => {
    const f = await varsRepo("push");
    await runTriggers(f.stub);
    const runId = await onlyRun(f, "push");
    expect(await planOf(runId)).toMatchObject({ runsOn: [["vars-label"]] });
    await finish(runId, "build");
    expect(await viewOf(runId)).toMatchObject({ conclusion: "success" });
    await changeVariable(f.owner, f.path, "LABEL", "changed");
    expect(await runStub(runId).rerun(f.owner.principalId)).toEqual({ ok: true, attempt: 2 });
    expect(await readVars(runId)).toEqual(READ_PLAN_VARS);
  });

  it("fails the run as variables_too_large when JSON escaping takes the contexts past the limit", async () => {
    // Within 256 KB of UTF-8, but each NUL is six bytes of JSON (`\u0000`).
    const nul = "\u0000".repeat(48 * 1024);
    const f = await varsRepo("push", { N1: nul, N2: nul, N3: nul, N4: nul, N5: nul });
    await runTriggers(f.stub);
    const runId = await onlyRun(f, "push");
    await at(runId, T0);
    await drain(runId);
    const view = await viewOf(runId);
    expect(view).toMatchObject({ status: "completed", conclusion: "failure", approval: null });
    expect(view.errors).toMatchObject([{ code: "variables_too_large" }]);
    expect(await varsOf(runId)).toEqual({});
    expect(await jobsOf(runId)).toEqual([]);
    expect(await runStub(runId).rerun(f.owner.principalId)).toMatchObject({ ok: false });
  });
});

describe("the contexts' size, measured with the run's own number", () => {
  it("keeps variables that fit a dispatch's contexts to the byte, and leaves them out one byte past", async () => {
    // A default of `"` takes four bytes of contexts a character (escaped, and shown twice).
    const f = await ciRepo({
      [CI]: [
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      big:",
        "        type: string",
        `        default: '${'"'.repeat(255_000)}'`,
        "jobs:",
        "  a:",
        "    runs-on: x",
        "    steps:",
        "      - run: a",
        "",
      ].join("\n"),
    });
    await setVariable(f.owner, f.path, "PAD", "x");
    await runTriggers(f.stub);
    const sizeOf = (runId: string) =>
      inRun(
        runId,
        (r) => new TextEncoder().encode((r.engine.run() as { contexts: string }).contexts).length,
      );
    // Run 1 measures the contexts with a one-byte value; runs 2 and 3 have numbers of its length.
    const first = await dispatch(f);
    expect(first.status).toBe(200);
    const measured = await sizeOf(first.body.workflow_run_id as string);
    const fill = MAX_RUN_CONTEXTS_BYTES - measured;
    expect(fill).toBeGreaterThan(0);
    expect(fill).toBeLessThan(48 * 1024);
    await changeVariable(f.owner, f.path, "PAD", "x".repeat(1 + fill));
    const exact = await dispatch(f);
    expect(exact.status).toBe(200);
    const fits = exact.body.workflow_run_id as string;
    expect(await sizeOf(fits)).toBe(MAX_RUN_CONTEXTS_BYTES);
    expect((await varsOf(fits)).PAD).toHaveLength(1 + fill);
    expect((await viewOf(fits)).errors ?? []).toEqual([]);
    await changeVariable(f.owner, f.path, "PAD", "x".repeat(2 + fill));
    const over = await dispatch(f);
    expect(over.status).toBe(200);
    const past = over.body.workflow_run_id as string;
    expect(await varsOf(past)).toEqual({});
    expect((await viewOf(past)).errors).toMatchObject([{ code: "variables_too_large" }]);
  });
});

describe("variablesFor", () => {
  it("takes the repository's alphabetically while they fit 256 KB, then the organization's in the space left", async () => {
    const admin = await user(true);
    const owner = await user();
    const org = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, org.login);
    const orgPath = `/orgs/${org.login}`;
    const path = `/repos/${org.login}/${repo.name}`;
    const full = "x".repeat(48 * 1024);
    // R1 to R5 are 245,770 bytes with their names; R6 would pass 262,144, so R7 is out too.
    for (const name of ["R5", "R3", "R1", "R2", "R4", "R6"])
      await setVariable(owner, path, name, full);
    await setVariable(owner, path, "R7", "small");
    // O1 fits in the 16,374 bytes left, O2 does not, and the organization's stop there.
    await setVariable(owner, orgPath, "O1", "small", { visibility: "all" });
    await setVariable(owner, orgPath, "O2", full, { visibility: "all" });
    await setVariable(owner, orgPath, "O3", "small", { visibility: "all" });
    const got = await variablesFor(org.id, repo.id);
    expect(got.ok && Object.keys(got.value)).toEqual(["R1", "R2", "R3", "R4", "R5", "O1"]);
  });

  it("reads the values of the variables it keeps only: the rest are sized, never read", async () => {
    const admin = await user(true);
    const owner = await user();
    const org = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, org.login);
    const full = "x".repeat(48 * 1024);
    const stub = env.ORG.getByName(org.id);
    // R1 to R5 fit; R6 does not, so it and the 40 after it are left out; O1 fits, O2 and O3 not.
    await inAccount(stub, (sql) => {
      const put = (scope: string, name: string, value: string, visibility: string | null) =>
        sql.exec(
          `INSERT INTO ci_variables (scope, name, value, visibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 0)`,
          scope,
          name,
          value,
          visibility,
        );
      for (const name of ["R1", "R2", "R3", "R4", "R5", "R6"]) put(repo.id, name, full, null);
      for (let i = 10; i < 50; i++) put(repo.id, `S${i}`, full, null);
      put("org", "O1", "small", "all");
      put("org", "O2", full, "all");
      for (let i = 10; i < 50; i++) put("org", `P${i}`, full, "all");
    });
    // Every statement the call runs, with the rows it read.
    const statements: {
      query: string;
      cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
    }[] = [];
    await inAccount(stub, (sql) => {
      const exec = sql.exec.bind(sql);
      sql.exec = ((query: string, ...bindings: unknown[]) => {
        const cursor = exec(query, ...bindings);
        statements.push({ query, cursor });
        return cursor;
      }) as typeof sql.exec;
    });
    try {
      const got = await variablesFor(org.id, repo.id);
      expect(got.ok && Object.keys(got.value)).toEqual(["R1", "R2", "R3", "R4", "R5", "O1"]);
    } finally {
      await inAccount(stub, (sql) => {
        delete (sql as { exec?: unknown }).exec;
      });
    }
    const reads = statements.filter((s) => /\bci_variables\b/.test(s.query));
    expect(reads.length).toBeGreaterThan(0);
    // Sizes come from the rows' metadata (`octet_length` of a column reads no content).
    const sizing = reads.filter((s) => /octet_length/.test(s.query));
    expect(sizing.length).toBeGreaterThan(0);
    // Outside `octet_length`, no sizing statement names a value.
    for (const s of sizing)
      expect(s.query.replace(/octet_length\([^)]*\)/g, "")).not.toMatch(/\bvalue\b/);
    // What reads values reads the six kept and their lookups, not the 82 left out.
    const valued = reads.filter((s) => !/octet_length/.test(s.query));
    const rowsRead = valued.reduce((n, s) => n + s.cursor.rowsRead, 0);
    expect(rowsRead).toBeLessThanOrEqual(12);
  });

  it("reads the repository's visibility from the directory when asked", async () => {
    const admin = await user(true);
    const owner = await user();
    const org = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, org.login, "public");
    await setVariable(owner, `/orgs/${org.login}`, "PRIV", "p", { visibility: "private" });
    expect(await variablesFor(org.id, repo.id)).toEqual({ ok: true, value: {} });
    await env.DIRECTORY.prepare("UPDATE repos SET visibility = 'internal' WHERE id = ?")
      .bind(repo.id)
      .run();
    expect(await variablesFor(org.id, repo.id)).toEqual({ ok: true, value: { PRIV: "p" } });
  });

  it("answers nothing for a repository the account does not hold", async () => {
    const admin = await user(true);
    const owner = await user();
    const org = await newOrg(admin, owner);
    await setVariable(owner, `/orgs/${org.login}`, "WIDE", "w", { visibility: "all" });
    const elsewhere = await ciRepo();
    expect(await variablesFor(org.id, elsewhere.repo.id)).toMatchObject({
      ok: false,
      code: "repo_not_found",
    });
  });
});

describe("snapshotVariables", () => {
  const utf8 = new TextEncoder();
  const size = (github: unknown, inputs: unknown, vars: unknown) =>
    utf8.encode(JSON.stringify({ github, inputs, vars })).length;
  /** A github context padded so the contexts with `vars` are exactly `total` bytes. */
  const padded = (vars: Record<string, string>, inputs: unknown, total: number) => {
    const base = size({ pad: "" }, inputs, vars);
    return { pad: "y".repeat(total - base) };
  };

  it("keeps variables that fit the contexts exactly", () => {
    const vars = { A: "x".repeat(1000) };
    const github = padded(vars, { i: 1 }, MAX_RUN_CONTEXTS_BYTES);
    expect(snapshotVariables(vars, github, { i: 1 })).toEqual({ vars });
    expect(validateRunSpec(specWith({ github, inputs: { i: 1 }, vars }))).toHaveLength(
      MAX_RUN_CONTEXTS_BYTES,
    );
  });

  it("leaves them all out, named, one byte past the limit", () => {
    const vars = { A: "x".repeat(1000) };
    const github = padded(vars, null, MAX_RUN_CONTEXTS_BYTES + 1);
    expect(snapshotVariables(vars, github, undefined)).toEqual({
      vars: {},
      varsError: "variables_too_large",
    });
  });

  it("measures the JSON encoding: NUL characters take six bytes, é takes two", () => {
    const github = { pad: "y".repeat(MAX_RUN_CONTEXTS_BYTES - 100_000) };
    // 20,000 bytes of UTF-8, 120,000 of JSON.
    expect(snapshotVariables({ N: "\u0000".repeat(20_000) }, github, null)).toMatchObject({
      varsError: "variables_too_large",
    });
    // 80,000 bytes either way.
    expect(snapshotVariables({ E: "é".repeat(40_000) }, github, null)).toEqual({
      vars: { E: "é".repeat(40_000) },
    });
  });

  it("names no error when there are no variables", () => {
    const github = { pad: "y".repeat(MAX_RUN_CONTEXTS_BYTES) };
    expect(snapshotVariables({}, github, null)).toEqual({ vars: {} });
  });
});

describe("a run's spec with a variables error", () => {
  it("fails the run at creation, before any attempt is admitted, and is part of its digest", async () => {
    const f = await repoWithCommit();
    const source = varsWorkflow("push");
    const spec = specFor(f, source, { vars: {}, varsError: "variables_too_large" });
    const created = await runStub(spec.runId).create(spec);
    expect(created).toMatchObject({ ok: true, created: true });
    const view = await viewOf(spec.runId);
    expect(view).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(view.errors).toMatchObject([{ code: "variables_too_large" }]);
    expect(await runStub(spec.runId).create(spec)).toMatchObject({ ok: true, created: false });
    const { varsError: _, ...without } = spec;
    expect(await runStub(spec.runId).create(without)).toEqual({ ok: false, code: "run_exists" });
  });

  it("is refused with any other error", () => {
    const f = { owner: { principalId: "usr_x" }, repo: { id: "rep_x" }, sha: "a".repeat(40) };
    expect(() =>
      validateRunSpec(
        specFor(f as Parameters<typeof specFor>[0], "x", {
          varsError: "other" as "variables_too_large",
        }),
      ),
    ).toThrow(/varsError/);
  });
});

// --- helpers -----------------------------------------------------------------------------

/** A spec for the size checks: contexts only matter. */
function specWith(contexts: Pick<RunSpec, "github" | "inputs" | "vars">): RunSpec {
  const f = { owner: { principalId: "usr_x" }, repo: { id: "rep_x" }, sha: "a".repeat(40) };
  return { ...specFor(f as Parameters<typeof specFor>[0], "x"), ...contexts };
}

const variablesFor = (accountId: string, repoId: string) =>
  env.ORG.getByName(accountId).ciVariablesFor(repoId);

/**
 * `env.ORG` recording each repository whose variables are asked for; the
 * first `failures` calls throw, and the `refusals` after them answer that
 * the account does not hold the repository.
 */
function countingOrg(asked: string[], failures = 0, refusals = 0) {
  return {
    getByName: (name: string) => ({
      ciVariablesFor: async (repoId: string) => {
        asked.push(repoId);
        if (failures > 0) {
          failures--;
          throw new Error("the account object could not be reached");
        }
        if (refusals > 0) {
          refusals--;
          return {
            ok: false,
            status: 404,
            code: "repo_not_found",
            error: "The repository is not this account's any more.",
          };
        }
        return env.ORG.getByName(name).ciVariablesFor(repoId);
      },
    }),
  } as unknown as DurableObjectNamespace<OrgDO>;
}

/** The spec stored with run `runId`'s allocation, or null once it is decided. */
const storedSpec = (f: CiRepo, runId: string) =>
  inRepo(
    f.stub,
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ spec: string }>("SELECT spec FROM ci_run_specs WHERE run_id = ?", runId)
        .toArray()[0]?.spec ?? null,
  );

/** The runs the repository recorded (registered). */
const registeredRuns = (f: CiRepo) =>
  inRepo(f.stub, (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ run_id: string }>("SELECT run_id FROM ci_runs")
      .toArray()
      .map((row) => row.run_id),
  );

/** The pending events' facts as an earlier version recorded them: without the owner. */
const withoutRecordedOwner = (f: CiRepo) =>
  inRepo(f.stub, (r: RepoDO) => {
    r.git.context.storage.sql.exec(
      "UPDATE ci_events SET facts = json_remove(facts, '$.recorded_owner') WHERE state = 'pending'",
    );
  });

/** POST …/transfer of the repository to account `login`. */
const transferTo = (f: CiRepo, login: string) =>
  json<{ state: string }>(api("POST", `${f.path}/transfer`, f.owner.token, { new_owner: login }));

/** POST …/dispatches of ci.yml on main. */
async function dispatch(f: CiRepo, key = crypto.randomUUID()) {
  const res = await exports.default.fetch(
    `${ORIGIN}/api${f.path}/actions/workflows/ci.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  return {
    status: res.status,
    body: (await res.json()) as { workflow_run_id?: string; code?: string },
  };
}

/**
 * The repository's dispatch asked again under the key of its one recorded
 * dispatch (as a request whose first answer was lost would), authorized
 * for the repository's owner now.
 */
async function dispatchAgain(f: CiRepo) {
  const key = await inRepo(f.stub, (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ key: string }>("SELECT key FROM ci_events WHERE kind = 'workflow_dispatch'")
      .one()
      .key.slice("dispatch:".length),
  );
  const entry = await env.DIRECTORY.prepare("SELECT owner_id, name_gen FROM repos WHERE id = ?")
    .bind(f.repo.id)
    .first<{ owner_id: string; name_gen: number }>();
  return f.stub.dispatchWorkflow({
    file: "ci.yml",
    ref: "main",
    inputs: {},
    actor: f.owner.principalId,
    key,
    authorized: { ownerId: entry?.owner_id as string, nameGen: entry?.name_gen as number },
  });
}
