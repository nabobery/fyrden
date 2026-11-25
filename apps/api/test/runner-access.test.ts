// What each runner's own access lets it be given, and that an ephemeral
// runner is given one task. Access is `repository_access` (with the
// selected repositories), `allows_public` and `allows_forks`: read by the
// claim, by every re-offer and by a run's reservation check, through one
// predicate. Labels never widen it.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CI_POLL_BUDGET, CI_POLL_LEASE } from "../src/ci/budget.js";
import { MAINTENANCE_OBJECT } from "../src/cron/maintenance.js";
import { DISPATCH_RESYNC_MS } from "../src/do/run/dispatch.js";
import type { RunSpec } from "../src/do/run/spec.js";
import {
  anyRunnerMayTake,
  clearStaleAccess,
  mayTake,
  transferAccessSql,
} from "../src/runner/access.js";
import { dispatchHooks } from "../src/runner/dispatch.js";
import { Result } from "../src/runner/proto/messages.js";
import { claimPending, leasePolls, revokeRunner, runnerAuthQuery } from "../src/runner/registry.js";
import { rowCountingD1 } from "./helpers/d1.js";
import { encodeFetchTaskRequest } from "./helpers/runner-proto.js";
import {
  allow,
  connectError,
  fetchTask,
  gate,
  jobTokensOf,
  newOrg,
  type OrgFixture,
  orgRepo,
  pendingOf,
  type RegisteredRunner,
  registerRunner,
  runnerCall,
  selectRepos,
  siblingRepo,
  tasksOfRun,
  tasksVersionOf,
  transferTo,
  updateTask,
} from "./helpers/runners.js";
import {
  advance,
  drain,
  inRun,
  job,
  jobsOf,
  runStub,
  specFor,
  started,
  workflow,
} from "./helpers/runs.js";

const one = workflow(job("a"));
const two = workflow([job("a"), job("b")].join("\n"));

afterEach(() => {
  delete dispatchHooks.afterClaim;
  delete dispatchHooks.beforeRefuse;
  vi.useRealTimers();
});

const setVisibility = (f: OrgFixture, visibility: "public" | "internal" | "private") =>
  env.DIRECTORY.prepare("UPDATE repos SET visibility = ? WHERE id = ?")
    .bind(visibility, f.repo.id)
    .run();

type JobKind = "push" | "pull_request" | "pull_request_target";

/** Starts a run of one job: a push, or a pull request from a fork that needs no approval. */
function start(f: OrgFixture, kind: JobKind, source = one) {
  if (kind === "push") return started(f, source);
  const yaml = `name: ci\non: ${kind}\njobs:\n${job("a")}`;
  const spec: RunSpec = specFor(f, yaml, {
    event: kind,
    ref: kind === "pull_request" ? "refs/pull/1/head" : "refs/heads/main",
    github: { event_name: kind, workflow: "ci" },
    trust: kind === "pull_request" ? "untrusted" : "trusted",
    fork: true,
  });
  return started(f, yaml, spec);
}

/** The account's tasks version made non-zero: a run's job published, then cancelled and withdrawn. */
async function primed(f: OrgFixture): Promise<number> {
  const runId = await started(f, one);
  await runStub(runId).cancel(f.owner.principalId, "graceful");
  await drain(runId);
  return tasksVersionOf(f.org.id);
}

/** An ephemeral runner of the organization, opted in to everything. */
async function opener(f: OrgFixture): Promise<RegisteredRunner> {
  const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
  await allow(runner, { public: true, forks: true });
  return runner;
}

/** A directory row of a repository and its account, and nothing else of them. */
const repoRow = (account: string, repo: string, visibility: string, state: string) => [
  env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'org', ?, 1)",
  ).bind(account, account),
  env.DIRECTORY.prepare(
    `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 's', ?, ?, 1, 1)`,
  ).bind(repo, account, repo, repo, visibility, state),
];

const rowsOf = async (run: (db: D1Database) => Promise<unknown>) => {
  const rows = { read: 0, written: 0 };
  await run(rowCountingD1(env.DIRECTORY, rows));
  return rows;
};

const rowOf = (runner: { id: number }) =>
  env.DIRECTORY.prepare(
    `SELECT allows_public, allows_forks, repository_access, task_assigned_at, task_confirmed_at,
       expires_at, revoked_at FROM ci_runners WHERE id = ?`,
  )
    .bind(runner.id)
    .first<Record<string, number | string | null>>();

describe("what a runner's access lets it be given", () => {
  const needs = (visibility: string, kind: JobKind) => ({
    public: visibility === "public",
    forks: kind !== "push",
  });
  for (const visibility of ["private", "internal", "public"] as const)
    for (const kind of ["push", "pull_request", "pull_request_target"] as const) {
      const need = needs(visibility, kind);
      it(`a ${kind === "push" ? "push" : `fork ${kind}`} job of a ${visibility} repository needs ${
        Object.entries(need)
          .filter(([, on]) => on)
          .map(([name]) => name)
          .join(" and ") || "nothing"
      }`, async () => {
        const f = await orgRepo();
        await setVisibility(f, visibility);
        // Never polls: it only makes the run reserve and publish the job.
        await opener(f);
        let runId = await start(f, kind);
        expect(await pendingOf(runId)).toHaveLength(1);
        for (const access of [
          { public: false, forks: false },
          { public: true, forks: false },
          { public: false, forks: true },
          { public: true, forks: true },
        ]) {
          const runner = await registerRunner(f.org.login, f.owner, {
            ephemeral: true,
            labels: ["ubuntu-latest", "self-hosted", "fork", "public"],
          });
          await allow(runner, access);
          const taken = (await fetchTask(runner, 0)).task !== undefined;
          expect([access, taken]).toEqual([
            access,
            (!need.public || access.public) && (!need.forks || access.forks),
          ]);
          if (taken) runId = await start(f, kind);
        }
      });
    }

  it("an ordinary long-lived runner may be opted in to public repositories, never to forks", async () => {
    const f = await orgRepo();
    await setVisibility(f, "public");
    const runner = await registerRunner(f.org.login, f.owner);
    await expect(allow(runner, { forks: true })).rejects.toThrow(/CHECK/);
    await allow(runner, { public: true });
    const runId = await start(f, "push");
    expect((await fetchTask(runner, 0)).task).toBeDefined();
    expect(await tasksOfRun(runId)).toHaveLength(1);
    // Its fork jobs wait for a runner that takes them.
    const fork = await start(f, "pull_request");
    expect(await pendingOf(fork)).toEqual([]);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
  });

  it("a selected runner takes only its repositories' jobs, and a removal stops the next claim", async () => {
    const f = await orgRepo();
    const sibling = await siblingRepo(f);
    const runner = await registerRunner(f.org.login, f.owner);
    await selectRepos(runner, [sibling.repo.id]);
    const other = await started(f, one);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(other)).toEqual([]);
    const chosen = await started(sibling, one);
    const task = (await fetchTask(runner, 0)).task;
    expect(task).toBeDefined();
    expect(await tasksOfRun(chosen)).toHaveLength(1);

    await selectRepos(runner, []);
    const next = await started(sibling, one);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(next)).toEqual([]);
    // What it was given before runs on.
    expect((await updateTask(runner, task?.id ?? 0)).state?.result).toBe(Result.UNSPECIFIED);
  });

  it("a narrowing between the offer and the re-offer withholds the job, whether assigned or not", async () => {
    const f = await orgRepo();
    const version = await primed(f);
    const runner = await registerRunner(f.org.login, f.owner);
    await selectRepos(runner, [f.repo.id]);
    const unassigned = await started(f, one);
    dispatchHooks.afterClaim = () => {
      throw new Error("the Worker died");
    };
    expect(
      (
        await runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: version }), {
          credentials: runner,
        })
      ).status,
    ).toBe(500);
    delete dispatchHooks.afterClaim;
    await selectRepos(runner, []);
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    expect((await tasksOfRun(unassigned))[0]).toMatchObject({ task: null });
    expect((await tasksOfRun(unassigned))[0]?.superseded_at).not.toBeNull();

    await selectRepos(runner, [f.repo.id]);
    const f2 = await siblingRepo(f);
    await selectRepos(runner, [f2.repo.id]);
    const assigned = await started(f2, one);
    const at = await tasksVersionOf(f.org.id);
    const lost = (await fetchTask(runner, at - 1)).task;
    if (!lost) throw new Error("no task");
    await selectRepos(runner, []);
    expect((await fetchTask(runner, at - 1)).task).toBeUndefined();
    expect((await tasksOfRun(assigned))[0]).toMatchObject({
      id: lost.id,
      task: 1,
      superseded_at: null,
      ended_at: null,
    });
    expect(await jobTokensOf(lost.id)).toHaveLength(1);
  });

  it("a runner revoked after it authenticated claims nothing", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = await started(f, one);
    const claim = {
      accountId: f.org.id,
      runnerId: runner.id,
      labels: ["ubuntu-latest"],
      ephemeral: false,
      version: 0,
      now: Date.now(),
    };
    await revokeRunner(env.DIRECTORY, { accountId: f.org.id, id: runner.id, now: Date.now() });
    expect(await claimPending(env.DIRECTORY, claim)).toBeUndefined();
    expect(await tasksOfRun(runId)).toEqual([]);
  });

  it("another account's opted-in runner opens nothing", async () => {
    const f = await orgRepo();
    await setVisibility(f, "public");
    const other = await orgRepo();
    await opener(other);
    const runId = await start(f, "push");
    expect(await pendingOf(runId)).toEqual([]);
  });
});

describe("which jobs a run reserves", () => {
  it("a fork job waits unreserved until a runner opts in, then is published within the resync", async () => {
    const f = await orgRepo();
    await primed(f);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const runId = await start(f, "pull_request_target");
    expect(await pendingOf(runId)).toEqual([]);
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(["queued"]);
    await allow(runner, { forks: true });
    await advance(runId, DISPATCH_RESYNC_MS);
    expect(await pendingOf(runId)).toHaveLength(1);
    expect((await fetchTask(runner, 0)).task).toBeDefined();
  });

  it.each([
    ["revoked", "revoked_at = 1, revoked_reason = 'deleted'"],
    ["past its end", "expires_at = 1"],
    ["already assigned its job", "task_assigned_at = 1"],
  ])("an opted-in runner %s reserves nothing", async (_, gone) => {
    const f = await orgRepo();
    const runner = await opener(f);
    await env.DIRECTORY.prepare(`UPDATE ci_runners SET ${gone} WHERE id = ?`).bind(runner.id).run();
    const runId = await start(f, "pull_request");
    expect(await pendingOf(runId)).toEqual([]);
  });

  it("agrees with what some serving runner, or a runner just registered, could be given", async () => {
    const access = fc.record({
      ephemeral: fc.boolean(),
      selected: fc.boolean(),
      chosen: fc.boolean(),
      public: fc.boolean(),
      forks: fc.boolean(),
      gone: fc.constantFrom("no", "revoked", "ended", "assigned"),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(access, { maxLength: 3 }),
        fc.constantFrom("private", "internal", "public"),
        fc.constantFrom("active", "deleting"),
        fc.boolean(),
        async (runners, visibility, state, fork) => {
          const account = uniqueId("acct");
          const repo = uniqueId("repo");
          const now = 1_000;
          await env.DIRECTORY.batch([
            ...repoRow(account, repo, visibility, state),
            ...runners.map((r) =>
              env.DIRECTORY.prepare(
                `INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at,
                   repository_access, allows_public, allows_forks, revoked_at, expires_at, task_assigned_at)
                 VALUES (?, ?, 'h', 'r', ?, 1, ?, ?, ?, ?, ?, ?)`,
              ).bind(
                uniqueId("runner"),
                account,
                r.ephemeral ? 1 : 0,
                r.selected ? "selected" : "all",
                r.public ? 1 : 0,
                r.forks && r.ephemeral ? 1 : 0,
                r.gone === "revoked" ? 1 : null,
                r.gone === "ended" ? now : null,
                r.gone === "assigned" ? 1 : null,
              ),
            ),
          ]);
          const { results: made } = await env.DIRECTORY.prepare(
            "SELECT id FROM ci_runners WHERE account_id = ? ORDER BY id",
          )
            .bind(account)
            .all<{ id: number }>();
          for (const [i, r] of runners.entries())
            if (r.chosen)
              await env.DIRECTORY.prepare("INSERT INTO ci_runner_repos VALUES (?, ?)")
                .bind(made[i]?.id ?? 0, repo)
                .run();
          const one = await env.DIRECTORY.prepare(
            `SELECT ${anyRunnerMayTake("?1", "?2", "?3")} AS some`,
          )
            .bind(repo, fork ? 1 : 0, now)
            .first<number>("some");
          const { results: each } = await env.DIRECTORY.prepare(
            `SELECT ${mayTake("r", "?1", "?2")} AS yes FROM ci_runners r WHERE r.account_id = ?3 ORDER BY r.id`,
          )
            .bind(repo, fork ? 1 : 0, account)
            .all<{ yes: number }>();
          const byDefault = state === "active" && visibility !== "public" && !fork;
          const model = runners.map(
            (r) =>
              state === "active" &&
              (visibility !== "public" || r.public) &&
              (!fork || (r.forks && r.ephemeral)) &&
              (!r.selected || r.chosen),
          );
          expect(each.map((r) => r.yes === 1)).toEqual(model);
          expect(one === 1).toBe(
            byDefault || runners.some((r, i) => r.gone === "no" && model[i] === true),
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("an ephemeral runner's one task", () => {
  it("is stamped when its assignment is recorded; a long-lived runner never is", async () => {
    const f = await orgRepo();
    const version = await primed(f);
    await started(f, two);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const task = (await fetchTask(runner, version)).task;
    expect(task).toBeDefined();
    const stamped = (await rowOf(runner))?.task_assigned_at;
    expect(stamped).not.toBeNull();
    expect((await rowOf(runner))?.task_confirmed_at).toBeNull();
    // The answer was lost: the same task again, the stamp kept.
    expect((await fetchTask(runner, version)).task?.id).toBe(task?.id);
    expect((await rowOf(runner))?.task_assigned_at).toBe(stamped);
    const long = await registerRunner(f.org.login, f.owner);
    expect((await fetchTask(long, 0)).task).toBeDefined();
    expect((await rowOf(long))?.task_assigned_at).toBeNull();
  });

  it("is the only one: after its run refuses the recorded offer, it is given nothing else", async () => {
    const f = await orgRepo();
    const version = await primed(f);
    const runId = await started(f, two);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const task = (await fetchTask(runner, version)).task;
    if (!task) throw new Error("no task");
    // The job is cancelled before the runner read the answer; the re-offer is refused.
    await inRun(runId, (r) => {
      r.hooks = {
        afterTaskEndCommit: () => {
          throw new Error("the end is handled later");
        },
      };
    });
    await runStub(runId).cancel(f.owner.principalId, "force");
    const waiting = await started(f, one);
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    await connectError(
      await runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: 0 }), {
        credentials: runner,
      }),
      "unauthenticated",
      401,
    );
    expect(await tasksOfRun(waiting)).toEqual([]);
    expect((await tasksOfRun(runId)).filter((t) => t.task !== null)).toHaveLength(1);
  });

  it("of a run erased before it reported ends the runner, which nothing else would", async () => {
    const f = await orgRepo();
    const version = await primed(f);
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    if (!(await fetchTask(runner, version)).task) throw new Error("no task");
    await runStub(runId).erase(f.repo.id);
    expect((await fetchTask(runner, version)).task).toBeUndefined();
    expect((await rowOf(runner))?.expires_at).not.toBeNull();
  });

  it("of a run erased while its assignment was recorded ends the runner too", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const record = gate();
    await inRun(runId, (r) => {
      r.hooks = { beforeTaskRecord: () => record.hold() };
    });
    const fetching = fetchTask(runner, 0);
    await record.started;
    await runStub(runId).erase(f.repo.id);
    record.release();
    expect((await fetching).task).toBeUndefined();
    const row = await rowOf(runner);
    expect(row?.task_assigned_at).not.toBeNull();
    expect(row?.expires_at).not.toBeNull();
  });

  it.each(["the stalled offer", "the later offer"])(
    "two offers of one runner, %s recorded first: one task",
    async (winner) => {
      const f = await orgRepo();
      const version = await primed(f);
      const first = await started(f, one);
      const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
      // The first assignment stalls before the directory records it, past its claim's lease.
      const stalled = gate();
      await inRun(first, (r) => {
        r.hooks = { beforeTaskRecord: () => stalled.hold() };
      });
      const slow = fetchTask(runner, version);
      await stalled.started;
      // Its pending row is withdrawn, so no lapsed claim supersedes the offer.
      await drain(first);
      expect(await pendingOf(first)).toEqual([]);
      vi.setSystemTime(Date.now() + 30_001);
      const second = await started(f, one);
      const later = gate();
      await inRun(second, (r) => {
        r.hooks = { beforeTaskRecord: () => later.hold() };
      });
      const fast = fetchTask(runner, 0);
      await later.started;
      const order = winner === "the stalled offer" ? [stalled, later] : [later, stalled];
      const answers = winner === "the stalled offer" ? [slow, fast] : [fast, slow];
      order[0]?.release();
      const won = await answers[0];
      order[1]?.release();
      const lost = await answers[1];
      expect(won?.task).toBeDefined();
      expect(lost?.task).toBeUndefined();
      const [won_, lost_] = winner === "the stalled offer" ? [first, second] : [second, first];
      expect(await tasksOfRun(won_)).toMatchObject([{ task: 1, superseded_at: null }]);
      const [row] = await tasksOfRun(lost_);
      expect(row).toMatchObject({ task: null });
      expect(row?.superseded_at).not.toBeNull();
      expect(await jobTokensOf(row?.id ?? 0)).toEqual([]);
      // The loser's job is queued again and another runner takes it.
      await inRun(lost_, (r) => {
        r.hooks = {};
      });
      await drain(lost_);
      expect((await jobsOf(lost_)).map((j) => j.status)).toEqual(["queued"]);
      const other = await registerRunner(f.org.login, f.owner);
      vi.setSystemTime(Date.now() + 30_001);
      expect((await fetchTask(other, 0)).task).toBeDefined();
    },
  );

  it("is stamped whichever Worker version recorded it, so a record refused before its report counts", async () => {
    const f = await orgRepo();
    const version = await primed(f);
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    dispatchHooks.afterClaim = () => {
      throw new Error("the Worker died");
    };
    await runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: version }), {
      credentials: runner,
    });
    delete dispatchHooks.afterClaim;
    const [offer] = await tasksOfRun(runId);
    // As a Worker from before the stamp records an assignment, and refuses it.
    await env.DIRECTORY.prepare("UPDATE ci_tasks SET task = 1 WHERE id = ?").bind(offer?.id).run();
    await env.DIRECTORY.prepare("UPDATE ci_tasks SET superseded_at = 5 WHERE id = ?")
      .bind(offer?.id)
      .run();
    expect((await rowOf(runner))?.task_assigned_at).not.toBeNull();
    const waiting = await started(f, one);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(waiting)).toEqual([]);
  });

  it("the migration counts every recorded assignment, also one later refused", async () => {
    const account = uniqueId("acct");
    const make = async (ephemeral: number, confirmed: number | null) =>
      (
        await env.DIRECTORY.prepare(
          `INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at, task_confirmed_at)
           VALUES (?, ?, 'h', 'r', ?, 1, ?) RETURNING id`,
        )
          .bind(uniqueId("runner"), account, ephemeral, confirmed)
          .first<{ id: number }>()
      )?.id as number;
    const offer = (runner: number, task: number | null, superseded: number | null, at: number) =>
      env.DIRECTORY.prepare(
        `INSERT INTO ci_tasks (run_id, job_id, task, runner_id, offered_version, created_at, superseded_at)
         VALUES (?, 1, ?, ?, 0, ?, ?)`,
      )
        .bind(uniqueId("run"), task, runner, at, superseded)
        .run();
    const confirmed = await make(1, 7);
    const refused = await make(1, null);
    await offer(refused, 1, 9, 5);
    await offer(refused, 1, null, 6);
    const unrecorded = await make(1, null);
    await offer(unrecorded, null, null, 5);
    const longLived = await make(0, null);
    await offer(longLived, 1, null, 5);
    const migrations = (
      env as unknown as { DIRECTORY_MIGRATIONS: { name: string; queries: string[] }[] }
    ).DIRECTORY_MIGRATIONS;
    const backfills = migrations
      .find((m) => m.name.includes("ci_runner_access"))
      ?.queries.filter((q) => q.includes("SET task_assigned_at") && !q.includes("CREATE TRIGGER"));
    expect(backfills?.length).toBeGreaterThan(0);
    await env.DIRECTORY.batch((backfills ?? []).map((q) => env.DIRECTORY.prepare(q)));
    const stamped = async (id: number) => (await rowOf({ id }))?.task_assigned_at;
    expect(await stamped(confirmed)).toBe(7);
    expect(await stamped(refused)).toBe(5);
    expect(await stamped(unrecorded)).toBeNull();
    expect(await stamped(longLived)).toBeNull();
  });
});

describe("access left behind", () => {
  const selections = (id: number) =>
    env.DIRECTORY.prepare("SELECT count(*) AS n FROM ci_runner_repos WHERE runner_id = ?")
      .bind(id)
      .first<number>("n");

  it("goes with a deleted runner, one a lease had revoked already too", async () => {
    const f = await orgRepo();
    for (const revoked of [null, 5]) {
      const runner = await opener(f);
      await selectRepos(runner, [f.repo.id]);
      await env.DIRECTORY.prepare("UPDATE ci_runners SET revoked_at = ? WHERE id = ?")
        .bind(revoked, runner.id)
        .run();
      expect(
        await revokeRunner(env.DIRECTORY, { accountId: f.org.id, id: runner.id, now: 9 }),
      ).toBe(true);
      expect(await rowOf(runner)).toMatchObject({ allows_public: 0, allows_forks: 0 });
      expect(await selections(runner.id)).toBe(0);
    }
  });

  it("stays with another account's runner a delete does not reach", async () => {
    const f = await orgRepo();
    const runner = await opener(f);
    await selectRepos(runner, [f.repo.id]);
    expect(
      await revokeRunner(env.DIRECTORY, { accountId: uniqueId("acct"), id: runner.id, now: 9 }),
    ).toBe(false);
    expect(await rowOf(runner)).toMatchObject({ allows_public: 1, allows_forks: 1 });
    expect(await selections(runner.id)).toBe(1);
  });

  it("goes when the cron stamps a spent runner, and when a lease revoked it", async () => {
    const f = await orgRepo();
    const spent = await opener(f);
    const leased = await opener(f);
    const serving = await opener(f);
    for (const runner of [spent, leased, serving]) await selectRepos(runner, [f.repo.id]);
    await env.DIRECTORY.prepare("UPDATE ci_runners SET expires_at = 3 WHERE id = ?")
      .bind(spent.id)
      .run();
    await env.DIRECTORY.prepare(
      "UPDATE ci_runners SET revoked_at = 4, revoked_reason = 'poll_rate' WHERE id = ?",
    )
      .bind(leased.id)
      .run();
    const maintenance = env.MAINTENANCE.getByName(MAINTENANCE_OBJECT);
    for (let i = 0; i < 5 && ((await selections(spent.id)) ?? 0) > 0; i++) await maintenance.run();
    for (let i = 0; i < 5 && ((await selections(leased.id)) ?? 0) > 0; i++) await maintenance.run();
    for (const runner of [spent, leased]) {
      expect(await rowOf(runner)).toMatchObject({ allows_public: 0, allows_forks: 0 });
      expect(await selections(runner.id)).toBe(0);
    }
    expect(await rowOf(serving)).toMatchObject({ allows_public: 1, allows_forks: 1 });
    expect(await selections(serving.id)).toBe(1);
  });

  it("is cleared a page at a time, reading no serving runner", async () => {
    const account = uniqueId("acct");
    const make = (count: number, revoked: number | null) =>
      env.DIRECTORY.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at,
           allows_public, allows_forks, revoked_at)
         SELECT ?2 || i, ?2, 'h', 'r', 1, 1, 1, 1, ?3 FROM n`,
      )
        .bind(count, `${account}-${revoked}`, revoked)
        .run();
    while ((await clearStaleAccess(env.DIRECTORY)) > 0);
    await make(500, null);
    const idle = await rowsOf(async (db) => expect(await clearStaleAccess(db)).toBe(0));
    expect(idle.read).toBeLessThanOrEqual(10);
    expect(idle.written).toBe(0);
    await make(7, 5);
    await env.DIRECTORY.prepare(
      `INSERT INTO ci_runner_repos SELECT id, 'r' FROM ci_runners WHERE account_id = ?`,
    )
      .bind(`${account}-5`)
      .run();
    expect(await clearStaleAccess(env.DIRECTORY, 4)).toBe(4);
    const left = await env.DIRECTORY.prepare(
      `SELECT count(*) AS n FROM ci_runner_repos WHERE runner_id IN
         (SELECT id FROM ci_runners WHERE account_id = ?)`,
    )
      .bind(`${account}-5`)
      .first<number>("n");
    expect(left).toBe(3);
    expect(await clearStaleAccess(env.DIRECTORY, 4)).toBe(3);
    expect(await clearStaleAccess(env.DIRECTORY, 4)).toBe(0);
  });

  it("a transferred repository leaves every selection, and returning does not select it again", async () => {
    const f = await orgRepo();
    const sibling = await siblingRepo(f);
    const to = await newOrg(f.owner);
    const runner = await registerRunner(f.org.login, f.owner);
    await selectRepos(runner, [f.repo.id, sibling.repo.id]);
    const token = (account: string, hash: string, expires: number, repos: string[]) =>
      env.DIRECTORY.prepare(
        `INSERT INTO ci_runner_registrations (token_hash, account_id, created_by, created_at, expires_at,
           repository_access, selected_repos) VALUES (?, ?, 'u', 1, ?, 'selected', ?)`,
      )
        .bind(hash, account, expires, JSON.stringify(repos))
        .run();
    const unused = uniqueId("hash");
    await token(f.org.id, unused, Date.now() + 3_600_000, [f.repo.id, sibling.repo.id]);
    await transferTo(f, to.login);
    const selected = async () =>
      (
        await env.DIRECTORY.prepare("SELECT repo_id FROM ci_runner_repos WHERE runner_id = ?")
          .bind(runner.id)
          .all<{ repo_id: string }>()
      ).results.map((r) => r.repo_id);
    expect(await selected()).toEqual([sibling.repo.id]);
    const kept = await env.DIRECTORY.prepare(
      "SELECT selected_repos FROM ci_runner_registrations WHERE token_hash = ?",
    )
      .bind(unused)
      .first<string>("selected_repos");
    expect(JSON.parse(kept ?? "null")).toEqual([sibling.repo.id]);

    await transferTo({ ...f, org: to }, f.org.login);
    expect(await selected()).toEqual([sibling.repo.id]);
    const runId = await started(f, one);
    expect((await fetchTask(runner, 0)).task).toBeUndefined();
    expect(await tasksOfRun(runId)).toEqual([]);
  });
});

describe("what access costs", () => {
  it("an idle poll reads the runner and the account's dispatch row, whatever its access", async () => {
    const f = await orgRepo();
    await primed(f);
    const runner = await opener(f);
    const version = await tasksVersionOf(f.org.id);
    const { read } = await rowsOf((db) =>
      db.prepare(runnerAuthQuery("fetch")).bind(runner.uuid, Date.now(), version).all(),
    );
    expect(read).toBeLessThanOrEqual(3);
  });

  it("the reservation check reads no runner that was assigned, ended or opted in to nothing", async () => {
    const account = uniqueId("acct");
    const repo = uniqueId("repo");
    await env.DIRECTORY.batch([
      ...repoRow(account, repo, "public", "active"),
      env.DIRECTORY.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
         INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at,
           allows_public, task_assigned_at)
         SELECT ?1 || i, ?1, 'h', 'r', 1, 1, i % 2, CASE i % 2 WHEN 1 THEN 1 END FROM n`,
      ).bind(account),
    ]);
    const { read } = await rowsOf((db) =>
      db
        .prepare(`SELECT ${anyRunnerMayTake("?1", "?2", "?3")} AS some`)
        .bind(repo, 0, Date.now())
        .all(),
    );
    expect(read).toBeLessThanOrEqual(8);
  });

  it("a poll lease of an opted-in runner writes what any lease writes", async () => {
    const f = await orgRepo();
    const fleet = { cap: 100_000, pollBudget: CI_POLL_BUDGET };
    const lease = async (runner: RegisteredRunner) =>
      (
        await rowsOf((db) =>
          leasePolls(db, { id: runner.id, now: Date.now(), block: CI_POLL_LEASE, fleet }),
        )
      ).written;
    const plain = await lease(await registerRunner(f.org.login, f.owner, { ephemeral: true }));
    expect(plain).toBeGreaterThan(0);
    expect(await lease(await opener(f))).toBe(plain);
  });

  it("a transfer reads no expired token and no runner that stopped serving", async () => {
    const account = uniqueId("acct");
    const repo = uniqueId("repo");
    const cost = () =>
      rowsOf((db) =>
        db.batch(
          transferAccessSql("?2 = ?2 AND ?3 = ?3 AND ?5 = ?5").map((sql) =>
            db.prepare(sql).bind(repo, "new", "name", account, 1_000),
          ),
        ),
      );
    const before = await cost();
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
         INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at, revoked_at)
         SELECT ?1 || i, ?1, 'h', 'r', 1, 1, 2 FROM n`,
      ).bind(account),
      env.DIRECTORY.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
         INSERT INTO ci_runner_registrations (token_hash, account_id, created_by, created_at,
           expires_at, repository_access, selected_repos)
         SELECT ?1 || i, ?1, 'u', 1, 999, 'selected', json_array(?2) FROM n`,
      ).bind(account, repo),
    ]);
    expect((await cost()).read - before.read).toBeLessThanOrEqual(2);
  });
});
