import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { expect, inject } from "vitest";
import type { RepoDO } from "../../src/do/RepoDO.js";
import type { RunView } from "../../src/do/RunDO.js";
import { CI_TRIGGERS_JOB } from "../../src/do/repo/ci-triggers.js";
import { api, json, user, type Who } from "./api.js";
import { scopedToken } from "./principals.js";
import { postPush } from "./push.js";
import { pushBody } from "./push-fixtures.js";
import { inRepo } from "./repo-git.js";
import { inRun, runStub } from "./runs.js";

/*
 * CI triggers in workerd tests: repositories whose changes record trigger
 * events, and the trigger job run explicitly (never by an alarm firing on
 * its own: the suite holds the clock a day ahead, AGENTS.md rule 7).
 */

function setSwitch(vars: { FYRDEN_CI_RUNNERS?: string }, on: boolean): void {
  vars.FYRDEN_CI_RUNNERS = on ? "on" : "off";
}

/**
 * Turns run creation on or off for this file's objects created from now on:
 * each object takes its variables from the isolate's `env` when it starts
 * (each test file has its own runtime).
 */
export function switchCi(on: boolean): void {
  setSwitch(env as { FYRDEN_CI_RUNNERS?: string }, on);
}

/** Turns run creation on or off for one repository object already running. */
export function switchRepoCi(stub: DurableObjectStub<RepoDO>, on: boolean) {
  return inRepo(stub, (r: RepoDO) =>
    setSwitch((r as unknown as { env: { FYRDEN_CI_RUNNERS?: string } }).env, on),
  );
}

export interface CiRepo {
  readonly owner: Who;
  readonly repo: { id: string; name: string };
  readonly path: string;
  readonly stub: DurableObjectStub<RepoDO>;
}

/** A user's new repository; with `files`, its first commit on main holds them. */
export async function ciRepo(files?: Record<string, string>, owner?: Who): Promise<CiRepo> {
  const who = owner ?? (await user());
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", who.token, { name: uniqueId("r") }),
  );
  expect(made.status).toBe(201);
  const f: CiRepo = {
    owner: who,
    repo: made.body,
    path: `/repos/${who.handle}/${made.body.name}`,
    stub: env.REPO.getByName(made.body.id),
  };
  if (files) await commit(f, "main", files, "first");
  return f;
}

/** A commit of `files` on `branch` (which must exist, or be main of an empty repository); its SHA. */
export async function commit(
  f: Pick<CiRepo, "path" | "owner">,
  branch: string,
  files: Record<string, string>,
  message = "change",
  who: Who = f.owner,
): Promise<string> {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${f.path}/file-commits`, who.token, {
      branch,
      message,
      changes: Object.entries(files).map(([path, content]) => ({ path, content })),
    }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
}

/** Moves refs as one git push (objects the repository has). */
export async function pushRefs(
  f: CiRepo,
  updates: readonly { old: string; new: string; ref: string }[],
  /** The pack to send, as hex; none by default (the objects are the repository's). */
  pack?: string,
): Promise<string> {
  const pushFixtures = inject("pushFixtures");
  const pushed = await postPush(
    {
      repo: { id: f.repo.id, name: f.repo.name, stub: f.stub },
      owner: {
        principalId: f.owner.principalId,
        token: await scopedToken(f.owner.principalId, [], "git"),
      },
      path: `/${f.owner.handle}/${f.repo.name}.git`,
    },
    pushBody(updates, { pack: pack ?? pushFixtures.packEmpty }),
  );
  return pushed.report.join("\n");
}

/** Runs the trigger job now, whatever its schedule, until it ends, waits or ends its invocation. */
export function runTriggers(stub: DurableObjectStub<RepoDO>) {
  return inRepo(stub, (r: RepoDO) =>
    r.git.jobs.runJob(
      CI_TRIGGERS_JOB,
      r.ciTriggers.handler(),
      r.git.memory,
      r.git.context.now() + 60_000,
    ),
  );
}

export interface EventRow {
  id: number;
  key: string;
  kind: string;
  state: string;
  outcome: string | null;
  actor_id: string | null;
  facts: string;
  resolved: string | null;
  created_at: number;
}

/**
 * The trigger inbox, oldest first; without the `schedule_refresh` events a
 * default-branch push or a change of the default branch also records,
 * unless `refreshes` asks for them.
 */
export const eventsOf = (stub: DurableObjectStub<RepoDO>, { refreshes = false } = {}) =>
  inRepo(stub, (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<EventRow & Record<string, SqlStorageValue>>(
        `SELECT * FROM ci_events ${refreshes ? "" : "WHERE kind != 'schedule_refresh'"} ORDER BY id`,
      )
      .toArray()
      .map((row) => ({ ...row }) as EventRow),
  );

export interface EventRunRow {
  event_id: number;
  trigger_kind: string;
  workflow_path: string;
  run_id: string;
  run_number: number;
  workflow_blob: string;
  started_at: number | null;
}

export const eventRunsOf = (stub: DurableObjectStub<RepoDO>) =>
  inRepo(stub, (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<EventRunRow & Record<string, SqlStorageValue>>(
        "SELECT * FROM ci_event_runs ORDER BY event_id, trigger_kind, workflow_path",
      )
      .toArray()
      .map((row) => ({ ...row }) as EventRunRow),
  );

/** The run's view (trust and fork included). */
export const viewOf = async (runId: string) => (await runStub(runId).get()) as RunView;

/** The `github` context the run was created with. */
export const githubOf = (runId: string) =>
  inRun(
    runId,
    (r) =>
      JSON.parse((r.engine.run() as { contexts: string }).contexts).github as Record<
        string,
        unknown
      >,
  );

/** The workflow source the run was created with. */
export const sourceOf = (runId: string) =>
  inRun(runId, (r) => (r.engine.run() as { workflow_source: string }).workflow_source);

/** A workflow file's text. */
export function workflowFile(on: string, name = "ci", job = "build"): string {
  return [
    `name: ${name}`,
    `on: ${on}`,
    "jobs:",
    `  ${job}:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
    "",
  ].join("\n");
}

/** `env.RUN` counting the run objects asked for. */
export function countingRuns(count: { runs: number }) {
  return new Proxy(env.RUN, {
    get(target, prop) {
      if (prop === "getByName" || prop === "get" || prop === "idFromName")
        return (...args: unknown[]) => {
          count.runs++;
          return (Reflect.get(target, prop) as (...a: unknown[]) => unknown).apply(target, args);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `env.DIRECTORY` counting every statement, batch and session started. */
export function countingDirectory(count: { d1: number }) {
  return new Proxy(env.DIRECTORY, {
    get(target, prop) {
      if (prop === "prepare" || prop === "batch" || prop === "exec" || prop === "withSession")
        return (...args: unknown[]) => {
          count.d1++;
          return (Reflect.get(target, prop) as (...a: unknown[]) => unknown).apply(target, args);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Sets (or removes) a Worker variable on a repository object, which copied `env` at its start. */
export const setVar = (stub: DurableObjectStub<RepoDO>, name: string, value: string | undefined) =>
  inRepo(stub, (r: RepoDO) => {
    const vars = (r as unknown as { env: Record<string, unknown> }).env;
    if (value === undefined) delete vars[name];
    else vars[name] = value;
  });
