import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { uniqueId } from "@fyrden/testing";
import { expect } from "vitest";
import { type StartRunAnswer, startRun } from "../../src/ci/runs.js";
import type { RepoDO } from "../../src/do/RepoDO.js";
import type { AssignAnswer, RunDO } from "../../src/do/RunDO.js";
import type { RunSpec } from "../../src/do/run/spec.js";
import { api, json, user, type Who } from "./api.js";
import { inRepo } from "./repo-git.js";

/*
 * CI runs in workerd tests. Each run object's clock is set by the test
 * (`at`, `advance`) and its due jobs run through `drain`, never on a timer:
 * the suite holds `Date` a day ahead so no alarm fires by itself (AGENTS.md
 * rule 7).
 */

export interface Fixture {
  readonly owner: Who;
  readonly repo: { id: string; name: string };
  readonly path: string;
  readonly sha: string;
}

/** A user, a repository of theirs and one commit on main. */
export async function repoWithCommit(): Promise<Fixture> {
  const owner = await user();
  const repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  const path = `/repos/${owner.handle}/${repo.name}`;
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, {
      branch: "main",
      message: "one",
      changes: [{ path: "a.txt", content: "one\n" }],
    }),
  );
  expect(made.status).toBe(201);
  return { owner, repo, path, sha: made.body.commit.sha };
}

export function specFor(f: Fixture, source: string, extra: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: newUlid(),
    repoId: f.repo.id,
    sha: f.sha,
    ref: "refs/heads/main",
    event: "push",
    actor: f.owner.principalId,
    workflow: { path: ".github/workflows/ci.yml", source },
    github: { ref: "refs/heads/main", event_name: "push", workflow: "ci" },
    ...extra,
  };
}

export const runStub = (runId: string) => env.RUN.getByName(runId);

type Outcome<R> = { ok: true; value: R } | { ok: false; message: string };

/** Runs `fn` inside the run object and rethrows its error here. */
export async function inRun<R>(runId: string, fn: (run: RunDO) => R | Promise<R>): Promise<R> {
  const outcome = await runInDurableObject(
    runStub(runId),
    async (run: RunDO): Promise<Outcome<R>> => {
      try {
        return { ok: true, value: await fn(run) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  if (outcome.ok) return outcome.value;
  throw new Error(outcome.message);
}

const clocks = new Map<string, number>();

/** Sets the run object's clock to `t` (kept across evictions by `drain` and `at`). */
export async function at(runId: string, t: number): Promise<void> {
  clocks.set(runId, t);
  await inRun(runId, (run) => {
    (run.context as { now: () => number }).now = () => clocks.get(runId) ?? Date.now();
  });
}

export const now = (runId: string): number => clocks.get(runId) ?? 0;

/** Runs the run object's due jobs until none is due at its clock; bounded. */
export async function drain(runId: string, rounds = 100): Promise<number> {
  let ran = 0;
  for (let i = 0; i < rounds; i++) {
    const due = await inRun(runId, async (run) => {
      if (clocks.has(runId))
        (run.context as { now: () => number }).now = () => clocks.get(runId) ?? Date.now();
      const next = run.jobs.nextAt();
      if (next === null || next > run.context.now()) return false;
      await run.alarm();
      return true;
    });
    if (!due) return ran;
    ran++;
  }
  throw new Error(`jobs still due after ${rounds} rounds`);
}

/** Moves the clock on by `ms` and runs what became due. */
export async function advance(runId: string, ms: number): Promise<void> {
  await at(runId, now(runId) + ms);
  await drain(runId);
}

/** Starts a run at clock `t0` and runs its first steps. */
export async function started(f: Fixture, source: string, extra: Partial<RunSpec> = {}) {
  const spec = specFor(f, source, extra);
  await at(spec.runId, T0);
  const answer: StartRunAnswer = await startRun(env, spec);
  expect(answer.ok).toBe(true);
  await at(spec.runId, T0);
  await drain(spec.runId);
  return spec.runId;
}

/** A fixed base time for run clocks, after the suite's held clock. */
export const T0 = Date.UTC(2030, 0, 1);

export const jobsOf = async (runId: string, attempt?: number) =>
  (await runStub(runId).listJobs(attempt))?.jobs ?? [];

export const jobNamed = async (runId: string, name: string, attempt?: number) => {
  const job = (await jobsOf(runId, attempt)).find((j) => j.name === name);
  if (!job) throw new Error(`no job ${name}`);
  return job;
};

/** Assigns job `name` to a runner and returns its task. */
export async function assignNamed(runId: string, name: string, key = `k-${name}`) {
  const job = await jobNamed(runId, name);
  const answer = (await runStub(runId).assign(job.jobId, key)) as AssignAnswer;
  if (!answer.ok) throw new Error(`assign ${name}: ${answer.code}`);
  return answer.task;
}

/** Assigns and completes job `name` with `result`, then runs what follows. */
export async function finish(
  runId: string,
  name: string,
  result: "success" | "failure" | "cancelled" | "skipped" = "success",
  outputs?: Record<string, string>,
) {
  const task = await assignNamed(runId, name);
  const done = await runStub(runId).completeTask(task, {
    result,
    ...(outputs ? { outputs } : {}),
    logComplete: true,
  });
  expect(done.ok).toBe(true);
  await drain(runId);
  return task;
}

/** The repository's check summaries on `sha`, by name. */
export async function checksOf(f: Fixture) {
  const rows = await inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) =>
    r.checks.summariesOn(f.sha),
  );
  return new Map(rows.map((row) => [row.name, row]));
}

/** A workflow expression, `${{ inner }}`, written without a template placeholder in a plain string. */
export function expr(inner: string): string {
  return ["$", "{{ ", inner, " }}"].join("");
}

/** Plain workflow YAML for a list of jobs. */
export function workflow(jobs: string): string {
  return `name: ci\non: push\njobs:\n${jobs}`;
}

export function job(id: string, lines: string[] = []): string {
  return [
    `  ${id}:`,
    "    runs-on: ubuntu-latest",
    ...lines.map((l) => `    ${l}`),
    "    steps:",
    `      - run: echo ${id}`,
  ].join("\n");
}
