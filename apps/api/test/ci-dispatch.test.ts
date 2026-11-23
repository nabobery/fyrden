// Workflows started by API (`workflow_dispatch`): the file named at the
// given ref, which must also exist on the default branch, with its inputs
// checked and typed; one run per dispatch (per idempotency claim), its id
// in the answer even when its start must be retried.
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { ReadsMemoryBusy } from "../src/do/repo/held-reads.js";
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
  switchCi,
  switchRepoCi,
  viewOf,
} from "./helpers/ci-triggers.js";
import { ORIGIN } from "./helpers/git-http.js";
import { callTool } from "./helpers/mcp.js";
import { ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";
import { at, drain, inRun, jobsOf, T0 } from "./helpers/runs.js";

const CI = ".github/workflows/ci.yml";
const DISPATCHABLE = [
  "name: deploy",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      env:",
  "        type: choice",
  "        options: [staging, prod]",
  "        required: true",
  "      debug:",
  "        type: boolean",
  "        default: false",
  "      level:",
  "        type: number",
  "        default: 1",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "",
].join("\n");

beforeAll(() => switchCi(true));
afterAll(() => switchCi(false));

type Answer = {
  workflow_run_id?: string;
  run_url?: string;
  html_url?: string;
  code?: string;
  errors?: { input?: string | null; message: string }[];
};

/** POST …/dispatches; `key` null sends no Idempotency-Key. */
async function dispatch(
  f: CiRepo,
  workflow: string,
  body: Record<string, unknown>,
  options: { key?: string | null; token?: string } = {},
) {
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  const res = await exports.default.fetch(
    `${ORIGIN}/api${f.path}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token ?? f.owner.token}`,
        "Content-Type": "application/json",
        ...(key !== null && { "Idempotency-Key": key }),
      },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json<Answer>() };
}

/** A repository whose main holds the dispatchable workflow (and `more`). */
const dispatchRepo = (more: Record<string, string> = {}) =>
  ciRepo({ [CI]: DISPATCHABLE, "a.txt": "one\n", ...more });

/** The run's typed `inputs` context. */
const inputsOf = (runId: string) =>
  inRun(runId, (r) => JSON.parse((r.engine.run() as { contexts: string }).contexts).inputs);

/** Runs of `workflow_dispatch` events, oldest first. */
async function dispatchRuns(f: CiRepo) {
  const events = await inRepo(f.stub, (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ id: number }>("SELECT id FROM ci_events WHERE kind = 'workflow_dispatch'")
      .toArray()
      .map((row) => row.id),
  );
  return (await eventRunsOf(f.stub)).filter((r) => events.includes(r.event_id));
}

describe("workflow_dispatch", () => {
  it("start a run with typed inputs and string event inputs, answering its id and links", async () => {
    const f = await dispatchRepo();
    const answer = await dispatch(f, "ci.yml", {
      ref: "main",
      inputs: { env: "prod", debug: "true", level: 3 },
    });
    expect(answer.status).toBe(200);
    const runId = answer.body.workflow_run_id ?? "";
    expect(answer.body).toEqual({
      workflow_run_id: runId,
      run_url: `${ORIGIN}/api${f.path}/actions/runs/${runId}`,
      html_url: `https://fyrden.test/${f.owner.handle}/${f.repo.name}/actions/runs/${runId}`,
    });
    const [run] = await dispatchRuns(f);
    expect(run).toMatchObject({ run_id: runId, run_number: 1, workflow_path: CI });
    const [event] = (await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch");
    expect(event).toMatchObject({ state: "done", outcome: null });
    expect(run?.started_at).not.toBeNull();
    expect(await viewOf(runId)).toMatchObject({
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      trust: "trusted",
      fork: false,
      approval: null,
      actor: f.owner.principalId,
    });
    expect(await inputsOf(runId)).toEqual({ env: "prod", debug: true, level: 3 });
    const github = await githubOf(runId);
    expect(github).toMatchObject({
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      ref_type: "branch",
      workflow: "deploy",
      run_number: "1",
    });
    expect(github.event).toMatchObject({
      inputs: { env: "prod", debug: "true", level: "3" },
      ref: "refs/heads/main",
      workflow: CI,
    });
    // The next dispatch of the same workflow is numbered after it.
    const next = await dispatch(f, "ci.yml", {
      ref: "refs/heads/main",
      inputs: { env: "staging" },
    });
    expect(next.status).toBe(200);
    expect((await githubOf(next.body.workflow_run_id ?? "")).run_number).toBe("2");
    expect(await inputsOf(next.body.workflow_run_id ?? "")).toEqual({
      env: "staging",
      debug: false,
      level: 1,
    });
  });

  it("requires the dispatch trigger on the default branch as well as the selected ref", async () => {
    const f = await dispatchRepo({
      ".github/workflows/push.yml":
        "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
    });
    const main = (await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token)))
      .body.sha;
    expect(await pushRefs(f, [{ old: ZERO, new: main, ref: "refs/heads/feature" }])).toContain(
      "ok refs/heads/feature",
    );
    await commit(f, "feature", { ".github/workflows/push.yml": DISPATCHABLE });
    const answer = await dispatch(f, "push.yml", { ref: "feature", inputs: { env: "prod" } });
    expect(answer).toMatchObject({ status: 422, body: { code: "workflow_not_dispatchable" } });
    expect(await dispatchRuns(f)).toEqual([]);
  });

  it("refuse bad inputs, a workflow without the trigger, and files or refs it cannot find", async () => {
    const f = await dispatchRepo({
      ".github/workflows/push.yml":
        "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
      ".github/workflows/broken.yml": "on: [workflow_dispatch\n",
      ".github/workflows/bad-default.yml": [
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      flag:",
        "        type: boolean",
        "        default: maybe",
        "jobs:",
        "  a:",
        "    runs-on: x",
        "    steps:",
        "      - run: a",
        "",
      ].join("\n"),
    });
    const main = (await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token)))
      .body.sha;
    expect(await pushRefs(f, [{ old: ZERO, new: main, ref: "refs/heads/feature" }])).toContain(
      "ok refs/heads/feature",
    );
    await commit(f, "feature", { ".github/workflows/only-here.yml": DISPATCHABLE });
    const refused = async (workflow: string, body: Record<string, unknown>) => {
      const answer = await dispatch(f, workflow, body);
      return { status: answer.status, code: answer.body.code, errors: answer.body.errors };
    };
    expect(
      await refused("ci.yml", { ref: "main", inputs: { env: "prod", colour: "red" } }),
    ).toMatchObject({
      status: 422,
      code: "invalid_inputs",
      errors: [{ input: "colour" }],
    });
    expect(await refused("ci.yml", { ref: "main" })).toMatchObject({
      status: 422,
      code: "invalid_inputs",
      errors: [{ input: "env" }],
    });
    expect(
      await refused("ci.yml", { ref: "main", inputs: { env: "prod", level: "high" } }),
    ).toMatchObject({
      status: 422,
      code: "invalid_inputs",
      errors: [{ input: "level" }],
    });
    expect(await refused("bad-default.yml", { ref: "main", inputs: { flag: true } })).toMatchObject(
      {
        status: 422,
        code: "invalid_inputs",
        errors: [{ input: "flag" }],
      },
    );
    expect(await refused("push.yml", { ref: "main" })).toMatchObject({
      status: 422,
      code: "workflow_not_dispatchable",
    });
    const broken = await refused("broken.yml", { ref: "main" });
    expect(broken).toMatchObject({ status: 422, code: "invalid_workflow" });
    expect(broken.errors?.length).toBeGreaterThan(0);
    expect(await refused("missing.yml", { ref: "main" })).toMatchObject({
      status: 404,
      code: "workflow_not_found",
    });
    expect(await refused("123", { ref: "main" })).toMatchObject({
      status: 404,
      code: "workflow_not_found",
    });
    // On the feature branch only: GitHub runs a dispatch only for a file on the default branch.
    expect(
      await refused("only-here.yml", { ref: "feature", inputs: { env: "prod" } }),
    ).toMatchObject({
      status: 404,
      code: "workflow_not_found",
    });
    expect(await refused("ci.yml", { ref: "nowhere", inputs: { env: "prod" } })).toMatchObject({
      status: 422,
      code: "ref_not_found",
    });
    expect(await refused("ci.yml", { ref: main, inputs: { env: "prod" } })).toMatchObject({
      status: 422,
      code: "ref_not_found",
    });
    expect(await dispatchRuns(f)).toEqual([]);
  });

  it("make one run, with one job, of the same key twice", async () => {
    const f = await dispatchRepo();
    const key = uniqueId("key");
    const first = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } }, { key });
    const again = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } }, { key });
    expect(again).toEqual(first);
    // The repository's own record of the dispatch answers the same run too.
    const entry = await env.DIRECTORY.prepare("SELECT owner_id, name_gen FROM repos WHERE id = ?")
      .bind(f.repo.id)
      .first<{ owner_id: string; name_gen: number }>();
    const authorized = { ownerId: entry?.owner_id as string, nameGen: entry?.name_gen as number };
    const direct = await f.stub.dispatchWorkflow({
      file: "ci.yml",
      ref: "main",
      inputs: { env: "prod" },
      actor: f.owner.principalId,
      key: "replayed-claim",
      authorized,
    });
    const repeat = await f.stub.dispatchWorkflow({
      file: "ci.yml",
      ref: "main",
      inputs: { env: "prod" },
      actor: f.owner.principalId,
      key: "replayed-claim",
      authorized,
    });
    expect(repeat).toEqual(direct);
    const runs = await dispatchRuns(f);
    expect(runs).toHaveLength(2);
    const runId = first.body.workflow_run_id ?? "";
    await at(runId, T0);
    await drain(runId);
    expect(await jobsOf(runId)).toHaveLength(1);
  });

  it("drop a run whose commit nothing roots any more by its start, answering commit_unreachable", async () => {
    const f = await dispatchRepo();
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        // The branch deleted and its reflog pruned before the start: a collection may be
        // leaving the commit as garbage.
        beforeStart: () => {
          r.git.context.storage.sql.exec("DELETE FROM refs WHERE name = 'refs/heads/main'");
          r.git.context.storage.sql.exec("DELETE FROM reflog");
        },
      };
    });
    const answer = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } });
    expect([answer.status, answer.body.code]).toEqual([409, "commit_unreachable"]);
    const [run] = await dispatchRuns(f);
    expect(run).toMatchObject({ outcome: "commit_unreachable", started_at: null });
    const recorded = await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec("SELECT 1 FROM ci_runs").toArray(),
    );
    expect(recorded).toEqual([]);
  });

  it("answer the run's id when its start fails after the record, and start it from the alarm", async () => {
    const f = await dispatchRepo();
    const clock = { now: Date.now() };
    await inRepo(f.stub, (r: RepoDO) => {
      (r.git.context as { now: () => number }).now = () => clock.now;
      let once = true;
      r.ciTriggers.hooks = {
        beforeStart: () => {
          if (!once) return;
          once = false;
          throw new Error("the run object could not be reached");
        },
      };
    });
    const answer = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } });
    expect(answer.status).toBe(200);
    const runId = answer.body.workflow_run_id ?? "";
    const [allocated] = await dispatchRuns(f);
    expect(allocated).toMatchObject({ run_id: runId, started_at: null });
    // Past the failed start's retry deadline, the job starts it.
    clock.now += 60 * 60_000;
    await runTriggers(f.stub);
    const runs = await dispatchRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.started_at).not.toBeNull();
    expect(await viewOf(runId)).toMatchObject({ event: "workflow_dispatch" });
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "workflow_dispatch")).toMatchObject([
      { state: "done", outcome: null },
    ]);
  });

  it("answer the run's id when the request dies right after the run's create", async () => {
    const f = await dispatchRepo();
    await inRepo(f.stub, (r: RepoDO) => {
      let once = true;
      r.ciTriggers.hooks = {
        afterStart: () => {
          if (!once) return;
          once = false;
          throw new Error("reset");
        },
      };
    });
    const answer = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } });
    expect(answer.status).toBe(200);
    const runId = answer.body.workflow_run_id ?? "";
    expect(await viewOf(runId)).toMatchObject({ event: "workflow_dispatch" });
    await runTriggers(f.stub);
    const runs = await dispatchRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_id: runId });
    expect(runs[0]?.started_at).not.toBeNull();
  });

  it("answer busy, not an error, when the repository's objects cannot be read now", async () => {
    const f = await dispatchRepo();
    await inRepo(f.stub, (r: RepoDO) => {
      let once = true;
      r.ciTriggers.hooks = {
        beforeRead: () => {
          if (!once) return;
          once = false;
          throw new ReadsMemoryBusy();
        },
      };
    });
    expect(await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } })).toMatchObject({
      status: 503,
      body: { code: "busy" },
    });
    expect(await dispatchRuns(f)).toEqual([]);
    expect((await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } })).status).toBe(
      200,
    );
  });

  it("run at a tag, preferring a branch of the same name", async () => {
    const f = await dispatchRepo();
    const first = (await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token)))
      .body.sha;
    expect(await pushRefs(f, [{ old: ZERO, new: first, ref: "refs/tags/v1" }])).toContain(
      "ok refs/tags/v1",
    );
    const tagged = await dispatch(f, "ci.yml", { ref: "v1", inputs: { env: "prod" } });
    expect(tagged.status).toBe(200);
    expect(await githubOf(tagged.body.workflow_run_id ?? "")).toMatchObject({
      ref: "refs/tags/v1",
      ref_type: "tag",
      sha: first,
    });
    const later = await commit(f, "main", { "a.txt": "two\n" });
    expect(await pushRefs(f, [{ old: ZERO, new: later, ref: "refs/heads/v1" }])).toContain(
      "ok refs/heads/v1",
    );
    const same = await dispatch(f, "ci.yml", { ref: "v1", inputs: { env: "prod" } });
    expect(await githubOf(same.body.workflow_run_id ?? "")).toMatchObject({
      ref: "refs/heads/v1",
      sha: later,
    });
    const full = await dispatch(f, "ci.yml", { ref: "refs/tags/v1", inputs: { env: "prod" } });
    expect(await githubOf(full.body.workflow_run_id ?? "")).toMatchObject({ sha: first });
  });

  it("make a new run of a key reused after its window, with other inputs or after the ref moved", async () => {
    const f = await dispatchRepo();
    const key = uniqueId("key");
    const expire = () =>
      env.DIRECTORY.prepare("UPDATE idempotency_keys SET expires_at = 1 WHERE key = ?")
        .bind(key)
        .run();
    const first = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } }, { key });
    await expire();
    const other = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "staging" } }, { key });
    expect(other.status).toBe(200);
    expect(other.body.workflow_run_id).not.toBe(first.body.workflow_run_id);
    const moved = await commit(f, "main", { "a.txt": "two\n" });
    await expire();
    const same = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "staging" } }, { key });
    expect(same.status).toBe(200);
    expect(same.body.workflow_run_id).not.toBe(other.body.workflow_run_id);
    expect((await viewOf(same.body.workflow_run_id ?? "")).sha).toBe(moved);
    expect(await dispatchRuns(f)).toHaveLength(3);
  });

  it("replay one key across /api and /api/v3, which stock gh calls", async () => {
    const f = await dispatchRepo();
    const key = uniqueId("key");
    const body = { ref: "main", inputs: { env: "prod" } };
    const first = await dispatch(f, "ci.yml", body, { key });
    const v3 = await exports.default.fetch(
      `${ORIGIN}/api/v3${f.path}/actions/workflows/ci.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${f.owner.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      },
    );
    expect(v3.status).toBe(200);
    expect(v3.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await v3.json()).toEqual(first.body);
    expect(await dispatchRuns(f)).toHaveLength(1);
  });

  it("make a run per request without an Idempotency-Key", async () => {
    const f = await dispatchRepo();
    const body = { ref: "main", inputs: { env: "prod" } };
    const one = await dispatch(f, "ci.yml", body, { key: null });
    const two = await dispatch(f, "ci.yml", body, { key: null });
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body.workflow_run_id).not.toBe(two.body.workflow_run_id);
    expect(await dispatchRuns(f)).toHaveLength(2);
  });

  it("refuse while CI is off", async () => {
    const f = await dispatchRepo();
    await switchRepoCi(f.stub, false);
    try {
      expect(await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } })).toMatchObject({
        status: 409,
        body: { code: "ci_off" },
      });
    } finally {
      await switchRepoCi(f.stub, true);
    }
    expect(await dispatchRuns(f)).toEqual([]);
  });

  it("take an agent with actions:write, and hide the repository from a reader", async () => {
    const f = await dispatchRepo();
    const agent = await agentFor(f.owner, ["actions:write"]);
    const byAgent = await dispatch(
      f,
      "ci.yml",
      { ref: "main", inputs: { env: "prod" } },
      { token: agent.delegated },
    );
    expect(byAgent.status).toBe(200);
    // Delegated: the run acts as the user the agent acts for, as a push by the same token
    // would; the agent alone has no role here, and the job's token could read nothing.
    expect(await viewOf(byAgent.body.workflow_run_id ?? "")).toMatchObject({
      event: "workflow_dispatch",
      actor: f.owner.principalId,
    });
    const reader: Who = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${reader.handle}`, f.owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBe(200);
    expect(
      await dispatch(
        f,
        "ci.yml",
        { ref: "main", inputs: { env: "prod" } },
        { token: reader.token },
      ),
    ).toMatchObject({ status: 404 });
  });

  it("answer busy for a storage or directory failure, and take the same key again after", async () => {
    const f = await dispatchRepo();
    const body = { ref: "main", inputs: { env: "prod" } };
    await inRepo(f.stub, (r: RepoDO) => {
      let once = true;
      r.ciTriggers.hooks = {
        beforeRead: () => {
          if (!once) return;
          once = false;
          throw new Error("the object store could not be reached");
        },
      };
    });
    const key = uniqueId("key");
    expect(await dispatch(f, "ci.yml", body, { key })).toMatchObject({
      status: 503,
      body: { code: "busy" },
    });
    expect(await dispatchRuns(f)).toEqual([]);
    expect((await dispatch(f, "ci.yml", body, { key })).status).toBe(200);

    await inRepo(f.stub, (r: RepoDO) => {
      const directory = env.DIRECTORY;
      let once = true;
      r.ciTriggers.bindings = {
        RUN: env.RUN,
        ORG: env.ORG,
        DIRECTORY: new Proxy(directory, {
          get(target, prop) {
            if (prop === "prepare" && once) {
              once = false;
              return () => {
                throw new Error("the directory could not be reached");
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
    });
    const other = uniqueId("key");
    expect(await dispatch(f, "ci.yml", body, { key: other })).toMatchObject({
      status: 503,
      body: { code: "busy" },
    });
    expect(await dispatchRuns(f)).toHaveLength(1);
    expect((await dispatch(f, "ci.yml", body, { key: other })).status).toBe(200);
    expect(await dispatchRuns(f)).toHaveLength(2);
  });

  it("refuse inputs whose run would hold more than its contexts may, and take them just below", async () => {
    // JSON doubles every `"`, and the inputs show twice (typed, and as event strings).
    const withDefault = (chars: number) =>
      [
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      big:",
        "        type: string",
        `        default: '${'"'.repeat(chars)}'`,
        "jobs:",
        "  a:",
        "    runs-on: x",
        "    steps:",
        "      - run: a",
        "",
      ].join("\n");
    const f = await dispatchRepo({
      ".github/workflows/below.yml": withDefault(250_000),
      ".github/workflows/above.yml": withDefault(270_000),
    });
    expect((await dispatch(f, "below.yml", { ref: "main" })).status).toBe(200);
    const refused = await dispatch(f, "above.yml", { ref: "main" });
    expect(refused).toMatchObject({
      status: 422,
      body: { code: "invalid_inputs", errors: [{ input: null }] },
    });
    expect(refused.body.errors?.[0]?.message).toMatch(/1048576 bytes/);
    expect(await dispatchRuns(f)).toHaveLength(1);
  });

  it("measure the contexts with the run's own number: up to the limit, and refused past it", async () => {
    const f = await dispatchRepo({
      ".github/workflows/big.yml": [
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      big:",
        "        type: string",
        `        default: '${'"'.repeat(255_000)}'`,
        "      small:",
        "        type: string",
        "        default: ''",
        "jobs:",
        "  a:",
        "    runs-on: x",
        "    steps:",
        "      - run: a",
        "",
      ].join("\n"),
    });
    const size = (runId: string) =>
      inRun(
        runId,
        (r) => new TextEncoder().encode((r.engine.run() as { contexts: string }).contexts).length,
      );
    const first = await dispatch(f, "big.yml", { ref: "main" });
    expect(first.status).toBe(200);
    // Each character of `small` takes two bytes (typed, and as an event string).
    const chars = Math.floor((1_048_576 - (await size(first.body.workflow_run_id as string))) / 2);
    const body = { ref: "main", inputs: { small: "a".repeat(chars) } };
    const fits = await dispatch(f, "big.yml", body);
    expect(fits.status).toBe(200);
    expect(await size(fits.body.workflow_run_id as string)).toBeGreaterThan(1_048_576 - 2);
    // The same inputs as run 999,999,999: eight more bytes of run number, past the limit.
    await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        "UPDATE ci_run_numbers SET last = 999999998 WHERE workflow_path = ?",
        ".github/workflows/big.yml",
      ),
    );
    expect(await dispatch(f, "big.yml", body)).toMatchObject({
      status: 422,
      body: { code: "invalid_inputs", errors: [{ input: null }] },
    });
    // Nothing recorded: no event, and the number not taken.
    expect(await dispatchRuns(f)).toHaveLength(2);
    expect(
      await inRepo(
        f.stub,
        (r: RepoDO) =>
          r.git.context.storage.sql
            .exec<{ last: number }>(
              "SELECT last FROM ci_run_numbers WHERE workflow_path = ?",
              ".github/workflows/big.yml",
            )
            .one().last,
      ),
    ).toBe(999_999_998);
  });
});

describe("workflow_dispatch over MCP", () => {
  /** The tool's arguments for `ci.yml` on main, with `more`. */
  const args = (f: CiRepo, more: Record<string, unknown> = {}) => ({
    owner: f.owner.handle,
    repo: f.repo.name,
    workflow_id: "ci.yml",
    ref: "main",
    inputs: { env: "prod" },
    ...more,
  });
  const claims = async (key: string) =>
    (
      await env.DIRECTORY.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE key = ?")
        .bind(key)
        .first<{ n: number }>()
    )?.n;

  it("make one run of the same idempotency_key twice, answering the same run", async () => {
    const f = await dispatchRepo();
    const key = uniqueId("key");
    const first = await callTool(
      f.owner.token,
      "dispatch_workflow",
      args(f, { idempotency_key: key }),
    );
    expect(first.isError, first.text).toBe(false);
    const again = await callTool(
      f.owner.token,
      "dispatch_workflow",
      args(f, { idempotency_key: key }),
    );
    expect(again).toEqual(first);
    expect(await dispatchRuns(f)).toHaveLength(1);
    // The key is the claim's, not part of the request: other inputs are another request.
    const other = await callTool(
      f.owner.token,
      "dispatch_workflow",
      args(f, { inputs: { env: "staging" }, idempotency_key: key }),
    );
    expect(other.isError).toBe(true);
    expect(JSON.parse(other.text)).toMatchObject({ code: "idempotency_key_reused" });
    expect(await dispatchRuns(f)).toHaveLength(1);
  });

  it("replay across REST and MCP for the same token, key and request", async () => {
    const f = await dispatchRepo();
    const key = uniqueId("key");
    const rest = await dispatch(f, "ci.yml", { ref: "main", inputs: { env: "prod" } }, { key });
    expect(rest.status).toBe(200);
    const mcp = await callTool(
      f.owner.token,
      "dispatch_workflow",
      args(f, { idempotency_key: key }),
    );
    expect(mcp.structured).toEqual(rest.body);
    expect(await dispatchRuns(f)).toHaveLength(1);
  });

  it("make a run per call without a key, as before", async () => {
    const f = await dispatchRepo();
    const one = await callTool(f.owner.token, "dispatch_workflow", args(f));
    const two = await callTool(f.owner.token, "dispatch_workflow", args(f));
    expect([one.isError, two.isError]).toEqual([false, false]);
    expect(one.structured?.workflow_run_id).not.toBe(two.structured?.workflow_run_id);
    expect(await dispatchRuns(f)).toHaveLength(2);
  });

  it("refuse a key that is not 1-255 visible ASCII characters before anything runs", async () => {
    const f = await dispatchRepo();
    for (const key of ["", "has space", "x".repeat(256), "é"]) {
      const answer = await callTool(
        f.owner.token,
        "dispatch_workflow",
        args(f, { idempotency_key: key }),
      );
      expect(answer.isError, key).toBe(true);
      expect(answer.text, key).toContain("idempotency_key");
      expect(await claims(key), key).toBe(0);
    }
    expect(await dispatchRuns(f)).toHaveLength(0);
  });
});
