// Scheduled workflows on the repository's own alarm: the default branch's
// cron entries are kept as rows (refreshed by default-branch pushes and by
// changes of the default branch), the `ci_schedule` job fires due rows into
// the trigger inbox, and the trigger runs the workflow on the default tip.
// Every clock here is the repository's, set by the test; every job runs
// explicitly.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordedAccount } from "../src/accounts/grants.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  CI_SCHEDULE_JOB,
  CiSchedules,
  type CiSchedulesDeps,
  latestOccurrence,
} from "../src/do/repo/ci-schedules.js";
import { ABSORB_PAGE, ABSORB_STEPS, CI_TRIGGERS_JOB } from "../src/do/repo/ci-triggers.js";
import { ciSince } from "../src/runner/service.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user } from "./helpers/api.js";
import {
  type CiRepo,
  ciRepo,
  commit,
  eventRunsOf,
  eventsOf,
  githubOf,
  pushRefs,
  runTriggers,
  setVar,
  switchCi,
  switchRepoCi,
  viewOf,
} from "./helpers/ci-triggers.js";
import { ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";
import { logs } from "./setup/log-capture.js";

const CI = ".github/workflows/nightly.yml";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeAll(() => switchCi(true));
afterAll(() => switchCi(false));

/** A workflow running on `crons`. */
function scheduled(crons: readonly string[], name = "nightly"): string {
  return [
    `name: ${name}`,
    "on:",
    "  schedule:",
    ...crons.map((c) => `    - cron: '${c}'`),
    "jobs:",
    "  a:",
    "    runs-on: x",
    "    steps:",
    "      - run: echo hi",
    "",
  ].join("\n");
}

interface Clocked extends CiRepo {
  /**
   * The repository's clock (ms); set it to move the repository in time.
   * While `real`, it reads real time: a write (a push, a commit, a settings
   * change) is checked against when the Worker authorized it.
   */
  readonly clock: { now: number; real: boolean };
}

/** Runs a write `change` of the repository with its clock on real time. */
async function live<T>(f: Clocked, change: () => Promise<T>): Promise<T> {
  f.clock.real = true;
  try {
    return await change();
  } finally {
    f.clock.real = false;
  }
}

const commitLive = (
  f: Clocked,
  branch: string,
  files: Record<string, string>,
  message?: string,
  who?: Parameters<typeof commit>[4],
) => live(f, () => commit(f, branch, files, message, who));
const pushLive = (f: Clocked, updates: Parameters<typeof pushRefs>[1]) =>
  live(f, () => pushRefs(f, updates));

/**
 * A repository whose first commit holds `files`, its clock then held at a
 * minute past the top of the next hour less one minute (so a `*\/5` cron's
 * first tick is the top of the hour, `base`), and its first push decided.
 */
async function scheduleRepo(
  files: Record<string, string> | ((base: number) => Record<string, string>),
): Promise<Clocked & { base: number }> {
  // The one read of the wall clock: everything a test expects derives from `base`.
  const base = Math.ceil((Date.now() + 2 * MINUTE) / (60 * MINUTE)) * 60 * MINUTE;
  const f = await ciRepo({
    "a.txt": "one\n",
    ...(typeof files === "function" ? files(base) : files),
  });
  const clock = { now: base - MINUTE, real: false };
  await inRepo(f.stub, (r: RepoDO) => {
    (r.git.context as { now: () => number }).now = () => (clock.real ? Date.now() : clock.now);
  });
  await runTriggers(f.stub);
  return { ...f, clock, base };
}

interface ScheduleRow {
  workflow_path: string;
  cron: string;
  actor_id: string;
  next_at: number;
  last_fired_at: number | null;
  disabled: string | null;
}

const rowsOf = (f: CiRepo) =>
  inRepo(f.stub, (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<ScheduleRow & Record<string, SqlStorageValue>>(
        "SELECT workflow_path, cron, actor_id, next_at, last_fired_at, disabled FROM ci_schedules ORDER BY workflow_path, cron",
      )
      .toArray()
      .map((row) => ({ ...row }) as ScheduleRow),
  );

const scheduleJob = (f: CiRepo) => inRepo(f.stub, (r: RepoDO) => r.git.jobs.get(CI_SCHEDULE_JOB));

/** Runs the schedule job at `at`, then the triggers; the schedule runs made since `from`. */
async function fireAt(f: Clocked, at: number) {
  f.clock.now = at;
  await inRepo(f.stub, (r: RepoDO) =>
    r.git.jobs.runJob(CI_SCHEDULE_JOB, r.ciSchedules.handler(), r.git.memory, at + 60_000),
  );
  await runTriggers(f.stub);
}

/** The scheduled runs so far, with the tick each was for, oldest first. */
async function scheduleRuns(f: CiRepo) {
  const events = new Map(
    (await eventsOf(f.stub)).filter((e) => e.kind === "schedule").map((e) => [e.id, e]),
  );
  return (await eventRunsOf(f.stub))
    .filter((r) => events.has(r.event_id))
    .map((r) => ({
      ...r,
      tick: (JSON.parse(events.get(r.event_id)?.facts ?? "{}") as { tick: number }).tick,
    }));
}

describe("scheduled workflows", () => {
  it("arm from a default-branch push, never from another branch's", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    expect(await rowsOf(f)).toEqual([
      {
        workflow_path: CI,
        cron: "*/5 * * * *",
        actor_id: f.owner.principalId,
        next_at: f.base,
        last_fired_at: null,
        disabled: null,
      },
    ]);
    expect(await scheduleJob(f)).toMatchObject({ state: "queued" });
    const main = await commitLive(f, "main", { "b.txt": "b\n" });
    expect(await pushLive(f, [{ old: ZERO, new: main, ref: "refs/heads/feature" }])).toContain(
      "ok refs/heads/feature",
    );
    await commitLive(f, "feature", { ".github/workflows/other.yml": scheduled(["0 3 * * *"]) });
    await runTriggers(f.stub);
    expect((await rowsOf(f)).map((r) => r.workflow_path)).toEqual([CI]);
  });

  it("refresh when the default branch changes to one with other schedules, with no push", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const main = (await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token)))
      .body.sha;
    expect(await pushLive(f, [{ old: ZERO, new: main, ref: "refs/heads/release" }])).toContain(
      "ok refs/heads/release",
    );
    await commitLive(f, "release", {
      [CI]: scheduled(["0 4 * * *"]),
      ".github/workflows/weekly.yml": scheduled(["0 5 * * 1"], "weekly"),
    });
    await runTriggers(f.stub);
    expect((await rowsOf(f)).map((r) => r.cron)).toEqual(["*/5 * * * *"]);
    const changed = await live(f, () =>
      api("PATCH", f.path, f.owner.token, { default_branch: "release" }),
    );
    expect(changed.status).toBe(200);
    await runTriggers(f.stub);
    const rows = await rowsOf(f);
    expect(rows.map((r) => [r.workflow_path, r.cron])).toEqual([
      [CI, "0 4 * * *"],
      [".github/workflows/weekly.yml", "0 5 * * 1"],
    ]);
    expect(rows.every((r) => r.actor_id === f.owner.principalId)).toBe(true);
  });

  it("keep a row's tick, last fire and actor across an unrelated push; a changed file rotates the actor", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await fireAt(f, f.base + 10_000);
    const [fired] = await rowsOf(f);
    expect(fired).toMatchObject({ last_fired_at: f.base, next_at: f.base + 5 * MINUTE });
    const writer = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated", writer);
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toEqual([fired]);
    await commitLive(
      f,
      "main",
      { [CI]: `${scheduled(["*/5 * * * *"])}# changed\n` },
      "edit",
      writer,
    );
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toEqual([{ ...fired, actor_id: writer.principalId }]);
  });

  it("fire one run on the default tip at its tick, and nothing on a duplicate alarm", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const tip = (await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token)))
      .body.sha;
    await fireAt(f, f.base + 10_000);
    const runs = await scheduleRuns(f);
    expect(runs.map((r) => r.tick)).toEqual([f.base]);
    const view = await viewOf(runs[0]?.run_id ?? "");
    expect(view).toMatchObject({
      event: "schedule",
      sha: tip,
      ref: "refs/heads/main",
      trust: "trusted",
      fork: false,
      approval: null,
      actor: f.owner.principalId,
    });
    expect(await githubOf(runs[0]?.run_id ?? "")).toMatchObject({
      event_name: "schedule",
      sha: tip,
      event: { schedule: "*/5 * * * *" },
    });
    await fireAt(f, f.base + 20_000);
    expect(await scheduleRuns(f)).toHaveLength(1);
  });

  it("fire one run after a 3 h outage, then keep 5 minutes between ticks", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["* * * * *"]) });
    await fireAt(f, f.base + 3 * 60 * MINUTE + 10_000);
    const runs = await scheduleRuns(f);
    expect(runs).toHaveLength(1);
    const [row] = await rowsOf(f);
    expect(row?.last_fired_at).toBe(f.base + 3 * 60 * MINUTE);
    expect(row?.next_at).toBe(f.base + 3 * 60 * MINUTE + 5 * MINUTE);
  });

  it("fire */5 at 12:00, 12:05 and 12:10, and * * * * * every 5 minutes", async () => {
    for (const cron of ["*/5 * * * *", "* * * * *"]) {
      const f = await scheduleRepo({ [CI]: scheduled([cron]) });
      for (let minute = 0; minute <= 10; minute++)
        await fireAt(f, f.base + minute * MINUTE + 10_000);
      expect((await scheduleRuns(f)).map((r) => (r.tick - f.base) / MINUTE)).toEqual([0, 5, 10]);
    }
  });

  it("fire a workflow with two cron entries at most every 5 minutes", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *", "2-59/5 * * * *"]) });
    for (let minute = 0; minute <= 12; minute++) await fireAt(f, f.base + minute * MINUTE + 10_000);
    const ticks = (await scheduleRuns(f)).map((r) => r.tick).sort((a, b) => a - b);
    expect(ticks.length).toBeGreaterThan(1);
    for (let i = 1; i < ticks.length; i++)
      expect((ticks[i] as number) - (ticks[i - 1] as number)).toBeGreaterThanOrEqual(5 * MINUTE);
  });

  it("disable rows after 60 days without a push, and enable them on the next default-branch push", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await fireAt(f, f.base + 61 * DAY);
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([{ disabled: "inactive" }]);
    await commitLive(f, "main", { "b.txt": "b\n" });
    await runTriggers(f.stub);
    const [row] = await rowsOf(f);
    expect(row?.disabled).toBeNull();
    expect(row?.next_at).toBeGreaterThan(f.clock.now);
  });

  it("disable a row whose actor may no longer write", async () => {
    const f = await scheduleRepo({ "b.txt": "b\n" });
    const writer = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    await commitLive(f, "main", { [CI]: scheduled(["*/5 * * * *"]) }, "add", writer);
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: writer.principalId, disabled: null }]);
    expect(
      (await api("DELETE", `${f.path}/collaborators/${writer.handle}`, f.owner.token)).status,
    ).toBeLessThan(300);
    await fireAt(f, f.base + 10_000);
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([{ disabled: "actor_lost" }]);
  });

  it("checks role revocation while the activity read is pending before recording the tick", async () => {
    const f = await scheduleRepo({ "b.txt": "b\n" });
    const writer = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    await commitLive(f, "main", { [CI]: scheduled(["*/5 * * * *"]) }, "add", writer);
    await runTriggers(f.stub);
    f.clock.now = f.base + 10_000;
    await inRepo(f.stub, async (r: RepoDO) => {
      const deps = (r.ciSchedules as unknown as { deps: CiSchedulesDeps }).deps;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const schedules = new CiSchedules({
        ...deps,
        actorActive: async (principal) => {
          const active = await deps.actorActive(principal);
          entered.resolve();
          await release.promise;
          return active;
        },
      });
      const firing = schedules.fire(f.clock.now);
      try {
        await Promise.race([
          entered.promise,
          firing.then(() => {
            throw new Error("schedule finished before the activity gate");
          }),
        ]);
        r.git.context.storage.sql.exec(
          "UPDATE acl_snapshot SET roles = '{}', version = version + 1",
        );
      } finally {
        release.resolve();
        await firing;
      }
    });
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([{ disabled: "actor_lost" }]);
  });

  it.each(["actor", "agent", "agent owner"] as const)(
    "does not fire if the %s is disabled while roles are refreshed",
    async (kind) => {
      const f = await scheduleRepo({ "b.txt": "b\n" });
      const writer = await user();
      expect(
        (
          await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
            permission: "push",
          })
        ).status,
      ).toBe(200);
      let actor = writer;
      let disabled = writer.principalId;
      if (kind !== "actor") {
        const agent = await agentFor(writer, ["contents:write"]);
        const account = await recordedAccount(env, {
          id: f.owner.principalId,
          handle: f.owner.handle,
        });
        const grant = await account.setCollaborator(
          { principalId: f.owner.principalId },
          f.repo.id,
          { id: agent.id, handle: agent.handle },
          "write",
        );
        if (!grant.ok) throw new Error(grant.error);
        await f.stub.invalidateAcl(f.owner.principalId, grant.epochGen, grant.version);
        actor = { principalId: agent.id, token: agent.own, handle: agent.handle };
        if (kind === "agent") disabled = agent.id;
      }
      await commitLive(f, "main", { [CI]: scheduled(["*/5 * * * *"]) }, "add", actor);
      await runTriggers(f.stub);
      await inRepo(f.stub, (r: RepoDO) => {
        const roleOf = r.acl.roleOf.bind(r.acl);
        r.acl.roleOf = async (...args) => {
          r.acl.roleOf = roleOf;
          const role = await roleOf(...args);
          await env.DIRECTORY.prepare(
            "UPDATE principals SET disabled_at = ?, lifecycle = CASE WHEN type = 'user' THEN 'suspended' ELSE lifecycle END, lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
          )
            .bind(Date.now(), disabled)
            .run();
          return role;
        };
      });
      await fireAt(f, f.base + 10_000);
      expect((await eventsOf(f.stub)).filter((e) => e.kind === "schedule")).toEqual([]);
      expect(await scheduleRuns(f)).toEqual([]);
      expect(await rowsOf(f)).toMatchObject([{ disabled: "actor_lost" }]);
    },
  );

  it("rechecks activity after the post-role boundary before recording a tick", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciSchedules.hooks = {
        afterRoleCheck: async () => {
          await env.DIRECTORY.prepare(
            "UPDATE principals SET disabled_at = ?, lifecycle = CASE WHEN type = 'user' THEN 'suspended' ELSE lifecycle END, lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
          )
            .bind(Date.now(), f.owner.principalId)
            .run();
        },
      };
    });
    await fireAt(f, f.base + 10_000);
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "schedule")).toEqual([]);
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([{ disabled: "actor_lost" }]);
  });

  it.each(["expires", "is invalidated"] as const)(
    "defers without disabling when the ACL %s during the activity read, then recovers",
    async (change) => {
      const f = await scheduleRepo({ "b.txt": "b\n" });
      const writer = await user();
      expect(
        (
          await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
            permission: "push",
          })
        ).status,
      ).toBe(200);
      await commitLive(f, "main", { [CI]: scheduled(["*/5 * * * *"]) }, "add", writer);
      await runTriggers(f.stub);
      f.clock.now = f.base + 10_000;
      const first = await inRepo(f.stub, async (r: RepoDO) => {
        const deps = (r.ciSchedules as unknown as { deps: CiSchedulesDeps }).deps;
        const pull = r.pullAcl;
        const schedules = new CiSchedules({
          ...deps,
          actorActive: async (principal) => {
            const active = await deps.actorActive(principal);
            const basis = r.acl.basis();
            if (typeof basis !== "object") throw new Error("no prepared ACL");
            if (change === "expires") {
              const aclNow = (r.acl as unknown as { deps: { now: () => number } }).deps.now();
              r.git.context.storage.sql.exec(
                "UPDATE acl_snapshot SET pulled_at = ?",
                aclNow - MINUTE,
              );
            } else r.acl.invalidate(basis.accountId, basis.epochGen, basis.version + 1);
            r.pullAcl = () => Promise.reject(new Error("account temporarily unavailable"));
            return active;
          },
        });
        try {
          return await schedules.fire(f.clock.now);
        } finally {
          r.pullAcl = pull;
        }
      });
      expect(first).toMatchObject({ done: false, cursor: null, runAfterMs: 60_000 });
      expect((await eventsOf(f.stub)).filter((e) => e.kind === "schedule")).toEqual([]);
      expect(await rowsOf(f)).toMatchObject([{ disabled: null, next_at: f.base }]);
      const reader = await user();
      expect(
        (
          await live(f, () =>
            api("PUT", `${f.path}/collaborators/${reader.handle}`, f.owner.token, {
              permission: "pull",
            }),
          )
        ).status,
      ).toBe(200);
      await fireAt(f, f.base + 70_000);
      expect((await scheduleRuns(f)).map((r) => r.tick)).toEqual([f.base]);
      expect(await rowsOf(f)).toMatchObject([{ disabled: null }]);
    },
  );

  it("start nothing for a tick whose cron left the file before the trigger read it", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    f.clock.now = f.base + 10_000;
    await inRepo(f.stub, (r: RepoDO) =>
      r.git.jobs.runJob(
        CI_SCHEDULE_JOB,
        r.ciSchedules.handler(),
        r.git.memory,
        f.clock.now + 60_000,
      ),
    );
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "schedule")).toHaveLength(1);
    await commitLive(f, "main", { [CI]: scheduled(["0 3 * * *"]) });
    await runTriggers(f.stub);
    expect(await scheduleRuns(f)).toEqual([]);
    expect((await eventsOf(f.stub)).filter((e) => e.kind === "schedule")).toMatchObject([
      { state: "done" },
    ]);
  });

  it("arm nothing and fire nothing while CI is off; no tick of that time is replayed after", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await switchRepoCi(f.stub, false);
    try {
      await commitLive(f, "main", {
        ".github/workflows/more.yml": scheduled(["0 3 * * *"], "more"),
      });
      await runTriggers(f.stub);
      expect((await rowsOf(f)).map((r) => r.workflow_path)).toEqual([CI]);
      await fireAt(f, f.base + 10_000);
      expect(await scheduleRuns(f)).toEqual([]);
      f.clock.now = f.base + DAY;
    } finally {
      await switchRepoCi(f.stub, true);
    }
    await commitLive(f, "main", { "b.txt": "b\n" });
    await runTriggers(f.stub);
    const rows = await rowsOf(f);
    expect(rows.every((r) => r.next_at > f.clock.now)).toBe(true);
    await fireAt(f, f.clock.now + 1_000);
    expect(await scheduleRuns(f)).toEqual([]);
  });

  it("arm nothing for a fork's initialization", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const forker = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${forker.handle}`, f.owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBe(200);
    const forked = await json<{ id: string }>(
      api("POST", `${f.path}/forks`, forker.token, { name: uniqueId("fork") }),
    );
    expect(forked.status).toBe(201);
    const fork = { ...f, stub: env.REPO.getByName(forked.body.id) };
    expect(await rowsOf(fork)).toEqual([]);
    expect(await eventsOf(fork.stub)).toEqual([]);
    expect(await scheduleJob(fork)).toBeUndefined();
  });

  it("keep at most 20 rows, recording why", async () => {
    const crons = Array.from({ length: 21 }, (_, i) => `${i} 3 * * *`);
    const f = await scheduleRepo({ [CI]: scheduled(crons) });
    expect(await rowsOf(f)).toHaveLength(20);
    // The refresh records why; the push's own event is not concerned.
    expect(await eventsOf(f.stub, { refreshes: true })).toMatchObject([
      { kind: "push", state: "done", outcome: null },
      { kind: "schedule_refresh", state: "done", outcome: "too_many_schedules" },
    ]);
  });

  it("fire a test tick ahead of the repository's clock: the ticks due then, and nothing else", async () => {
    const LATER = ".github/workflows/later.yml";
    const f = await scheduleRepo({
      [CI]: scheduled(["*/5 * * * *"]),
      [LATER]: scheduled(["10 * * * *"], "later"),
    });
    // The clock is held a minute before `base`, the five-minute entry's first tick.
    expect(f.clock.now).toBe(f.base - MINUTE);
    expect(await f.stub.ciScheduleTick(f.base)).toEqual({ ok: true });
    expect(await scheduleRuns(f)).toMatchObject([{ workflow_path: CI, tick: f.base }]);
    expect(
      (await rowsOf(f)).map((r) => [r.workflow_path, r.next_at, r.last_fired_at, r.disabled]),
    ).toEqual([
      [LATER, f.base + 10 * MINUTE, null, null],
      [CI, f.base + 5 * MINUTE, f.base, null],
    ]);
  });

  it("refuse a test tick while the cutoff is ahead of the repository's clock, changing nothing", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const before = await rowsOf(f);
    await setVar(f.stub, "FYRDEN_CI_SINCE", String(f.clock.now + 4 * MINUTE));
    try {
      expect(await f.stub.ciScheduleTick(f.base + 120 * MINUTE)).toEqual({
        ok: false,
        code: "cutoff_ahead",
      });
      expect(await rowsOf(f)).toEqual(before);
      expect(await scheduleRuns(f)).toEqual([]);
    } finally {
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });

  it("never let an older push's refresh, retried late, overwrite a newer one's", async () => {
    const f = await scheduleRepo({ "a.txt": "two\n" });
    await inRepo(f.stub, (r: RepoDO) => {
      let failing = true;
      r.ciTriggers.hooks = {
        beforeStart: () => {
          if (failing) {
            failing = false;
            throw new Error("the run object could not be reached");
          }
        },
      };
    });
    // A: a schedule and a push workflow (its start fails once); B: both removed.
    await commitLive(f, "main", {
      [CI]: scheduled(["*/5 * * * *"]),
      ".github/workflows/push.yml":
        "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
    });
    await commitLive(f, "main", {
      [CI]: "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
    });
    await runTriggers(f.stub);
    f.clock.now += 60 * MINUTE;
    await runTriggers(f.stub);
    expect((await eventsOf(f.stub, { refreshes: true })).every((e) => e.state === "done")).toBe(
      true,
    );
    expect(await rowsOf(f)).toEqual([]);
  });

  it("give a default-branch change's rows to whoever changed it, enabling a lost actor's", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const admin = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${admin.handle}`, f.owner.token, {
          permission: "admin",
        })
      ).status,
    ).toBe(200);
    const main = (await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token)))
      .body.sha;
    await pushLive(f, [{ old: ZERO, new: main, ref: "refs/heads/release" }]);
    await runTriggers(f.stub);
    await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec("UPDATE ci_schedules SET disabled = 'actor_lost'"),
    );
    const changed = await live(f, () =>
      api("PATCH", f.path, admin.token, { default_branch: "release" }),
    );
    expect(changed.status).toBe(200);
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: admin.principalId, disabled: null }]);
  });

  it("neither fire nor disable while the account cannot be reached, and fire once it can", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await inRepo(f.stub, (r: RepoDO) => {
      const repo = r as RepoDO & { savedPullAcl?: RepoDO["pullAcl"] };
      repo.savedPullAcl = repo.pullAcl;
      repo.pullAcl = () => Promise.reject(new Error("account unreachable"));
      r.git.context.storage.sql.exec("DELETE FROM acl_snapshot");
    });
    await fireAt(f, f.base + 10_000);
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([{ disabled: null, next_at: f.base }]);
    await inRepo(f.stub, (r: RepoDO) => {
      const repo = r as RepoDO & { savedPullAcl?: RepoDO["pullAcl"] };
      if (repo.savedPullAcl) repo.pullAcl = repo.savedPullAcl;
    });
    await fireAt(f, f.base + 20_000);
    expect((await scheduleRuns(f)).map((r) => r.tick)).toEqual([f.base]);
  });

  it("never fire with an actor whose authority was not checked: a refresh during the check", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const stranger = await user();
    await inRepo(f.stub, (r: RepoDO) => {
      let once = true;
      r.ciSchedules.hooks = {
        afterRoleCheck: (path) => {
          if (!once) return;
          once = false;
          // A refresh lands while the old actor is checked: another file, another actor.
          r.ciSchedules.apply(
            Number.MAX_SAFE_INTEGER,
            [{ path, blob: "f".repeat(40), crons: ["*/5 * * * *"] }],
            stranger.principalId,
          );
        },
      };
    });
    await fireAt(f, f.base + 10_000);
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([
      { actor_id: stranger.principalId, disabled: "actor_lost" },
    ]);
  });

  it("keep the actor who changed the file when an unrelated push's refresh runs first", async () => {
    const both = (marker: string) =>
      `${scheduled(["*/5 * * * *"]).replace("on:\n", "on:\n  push:\n")}# ${marker}\n`;
    const f = await scheduleRepo({ [CI]: both("x") });
    const writer = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    await inRepo(f.stub, (r: RepoDO) => {
      let failing = true;
      r.ciTriggers.hooks = {
        beforeStart: () => {
          if (failing) {
            failing = false;
            throw new Error("the run object could not be reached");
          }
        },
      };
    });
    // A (the writer) changes the file, and its run's start fails; B (the owner) pushes another.
    await commitLive(f, "main", { [CI]: both("y") }, "change", writer);
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    await runTriggers(f.stub);
    f.clock.now += 60 * MINUTE;
    await runTriggers(f.stub);
    expect((await eventsOf(f.stub, { refreshes: true })).every((e) => e.state === "done")).toBe(
      true,
    );
    expect(await rowsOf(f)).toMatchObject([{ actor_id: writer.principalId }]);
  });

  it("keep a workflow's last fire when its cron is replaced", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await fireAt(f, f.base + 10_000);
    f.clock.now = f.base + MINUTE;
    await commitLive(f, "main", { [CI]: scheduled(["* * * * *"]) });
    await runTriggers(f.stub);
    for (let minute = 2; minute <= 5; minute++) await fireAt(f, f.base + minute * MINUTE + 10_000);
    expect((await scheduleRuns(f)).map((r) => (r.tick - f.base) / MINUTE)).toEqual([0, 5]);
  });

  it("coalesce an outage's ticks into one run though a refresh came in between", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    f.clock.now = f.base + 3 * 60 * MINUTE;
    await commitLive(f, "main", { "b.txt": "b\n" });
    await runTriggers(f.stub);
    await fireAt(f, f.base + 3 * 60 * MINUTE + 10_000);
    expect((await scheduleRuns(f)).map((r) => (r.tick - f.base) / MINUTE)).toEqual([180]);
  });

  it("replay no tick that fell while CI was off, however short the off time", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await switchRepoCi(f.stub, false);
    try {
      await fireAt(f, f.base + 10_000);
    } finally {
      await switchRepoCi(f.stub, true);
    }
    // Nothing is armed while off: the next event recorded with CI on resumes the schedules
    // from then, replaying none.
    f.clock.now = f.base + 10 * MINUTE;
    await commitLive(f, "main", { "b.txt": "b\n" });
    await runTriggers(f.stub);
    await fireAt(f, f.base + 10 * MINUTE + 10_000);
    expect(await scheduleRuns(f)).toEqual([]);
    await fireAt(f, f.base + 15 * MINUTE + 10_000);
    expect((await scheduleRuns(f)).map((r) => (r.tick - f.base) / MINUTE)).toEqual([15]);
  });

  it("record an hourly entry's latest occurrence, not its first missed one", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["0 * * * *"]) });
    await fireAt(f, f.base + 2 * 60 * MINUTE + 10 * MINUTE);
    expect((await scheduleRuns(f)).map((r) => (r.tick - f.base) / MINUTE)).toEqual([120]);
  });

  it("disable a row whose actor was suspended", async () => {
    const f = await scheduleRepo({ "b.txt": "b\n" });
    const writer = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    await commitLive(f, "main", { [CI]: scheduled(["*/5 * * * *"]) }, "add", writer);
    await runTriggers(f.stub);
    const admin = await user(true);
    expect((await api("PUT", `/users/${writer.handle}/suspended`, admin.token, {})).status).toBe(
      204,
    );
    await fireAt(f, f.base + 10_000);
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([{ disabled: "actor_lost" }]);
  });

  it("neither fire nor disable when the actor's check fails or its ACL lapses during the fire", async () => {
    const f = await scheduleRepo({ "b.txt": "b\n" });
    const writer = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    await commitLive(f, "main", { [CI]: scheduled(["*/5 * * * *"]) }, "add", writer);
    await runTriggers(f.stub);
    await inRepo(f.stub, (r: RepoDO) => {
      let once = true;
      r.ciSchedules.hooks = {
        beforeRoleCheck: () => {
          if (!once) return;
          once = false;
          throw new Error("the directory could not be reached");
        },
      };
    });
    await fireAt(f, f.base + 10_000);
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([{ disabled: null, next_at: f.base }]);
    await inRepo(f.stub, (r: RepoDO) => {
      const repo = r as RepoDO & { savedPullAcl?: RepoDO["pullAcl"] };
      let once = true;
      r.ciSchedules.hooks = {
        beforeRoleCheck: () => {
          if (!once) return;
          once = false;
          // The ACL lapses after the fire's first check: the actor's role cannot be read.
          repo.savedPullAcl = repo.pullAcl;
          repo.pullAcl = () => Promise.reject(new Error("account unreachable"));
          r.git.context.storage.sql.exec("DELETE FROM acl_snapshot");
        },
      };
    });
    await fireAt(f, f.base + 20_000);
    expect(await scheduleRuns(f)).toEqual([]);
    expect(await rowsOf(f)).toMatchObject([{ disabled: null, next_at: f.base }]);
    await inRepo(f.stub, (r: RepoDO) => {
      const repo = r as RepoDO & { savedPullAcl?: RepoDO["pullAcl"] };
      if (repo.savedPullAcl) repo.pullAcl = repo.savedPullAcl;
    });
    await fireAt(f, f.base + 30_000);
    expect((await scheduleRuns(f)).map((r) => r.tick)).toEqual([f.base]);
  });

  it("refresh from a default-branch push whose own run never starts", async () => {
    const both = `${scheduled(["*/5 * * * *"]).replace("on:\n", "on:\n  push:\n")}`;
    const f = await scheduleRepo({ "b.txt": "b\n" });
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeStart: () => {
          throw new Error("the run object could not be reached");
        },
      };
    });
    await commitLive(f, "main", { [CI]: both });
    for (let i = 0; i < 3; i++) {
      await runTriggers(f.stub);
      f.clock.now += 60 * MINUTE;
    }
    expect(await rowsOf(f)).toMatchObject([{ workflow_path: CI, cron: "*/5 * * * *" }]);
  });

  it("keep the actor who changed the file though their push's evaluation failed", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const writer = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# y\n` }, "change", writer);
    // The writer's push event is given up (as `evaluation_failed` after repeated faults).
    await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        `UPDATE ci_events SET state = 'done', outcome = 'evaluation_failed', done_at = 1
         WHERE kind = 'push' AND state = 'pending'`,
      ),
    );
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: writer.principalId }]);
  });

  it("fire no tick from before the deployment's CI cutoff, which no object saw pass", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    // CI was switched off and on again around the 12:00 tick with nothing running in between;
    // whoever switched it on set the cutoff to then.
    await setVar(f.stub, "FYRDEN_CI_SINCE", new Date(f.base + 20_000).toISOString());
    try {
      await fireAt(f, f.base + 30_000);
      expect(await scheduleRuns(f)).toEqual([]);
      expect((await rowsOf(f))[0]?.next_at).toBe(f.base + 5 * MINUTE);
      await fireAt(f, f.base + 5 * MINUTE + 10_000);
      expect((await scheduleRuns(f)).map((r) => (r.tick - f.base) / MINUTE)).toEqual([5]);
    } finally {
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });

  it("read the cutoff as a time with a zone or epoch milliseconds, and nothing else", () => {
    const read = (value: unknown) => ciSince({ FYRDEN_CI_SINCE: value });
    expect(ciSince({})).toBeNull();
    expect(read("")).toBeNull();
    expect(read("2026-11-16T09:00:00Z")).toBe(Date.UTC(2026, 10, 16, 9));
    expect(read("2026-11-16T10:00:00.000+01:00")).toBe(Date.UTC(2026, 10, 16, 9));
    expect(read("1794819600000")).toBe(1794819600000);
    expect(read("8640000000000000")).toBe(8_640_000_000_000_000);
    for (const bad of [
      "soon",
      "2026-11-16T09:00:00",
      "2026-11-16",
      "-5",
      "1e12",
      5,
      "8640000000000001",
      "9007199254740991",
    ])
      expect(read(bad)).toBe("unreadable");
  });

  it("take a cutoff that cannot be read as none", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await setVar(f.stub, "FYRDEN_CI_SINCE", "soon");
    try {
      await fireAt(f, f.base + 30_000);
      expect((await scheduleRuns(f)).map((r) => r.tick)).toEqual([f.base]);
    } finally {
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });

  it("record the latest of clustered occurrences, and exact boundaries", async () => {
    // Every minute of the base's hour and the two after, all from the base `scheduleRepo` takes.
    const clustered = await scheduleRepo((base) => {
      const hour = new Date(base).getUTCHours();
      const hours = [0, 1, 2].map((i) => (hour + i) % 24);
      return { [CI]: scheduled([`* ${hours.join(",")} * * *`]) };
    });
    await fireAt(clustered, clustered.base + 4 * 60 * MINUTE + 30 * MINUTE);
    expect((await scheduleRuns(clustered)).map((r) => (r.tick - clustered.base) / MINUTE)).toEqual([
      2 * 60 + 59,
    ]);

    const exact = await scheduleRepo({ [CI]: scheduled(["0 * * * *"]) });
    await fireAt(exact, exact.base + 2 * 60 * MINUTE);
    expect((await scheduleRuns(exact)).map((r) => (r.tick - exact.base) / MINUTE)).toEqual([120]);

    const before = await scheduleRepo({ [CI]: scheduled(["0 * * * *"]) });
    await fireAt(before, before.base + 2 * 60 * MINUTE - 1);
    expect((await scheduleRuns(before)).map((r) => (r.tick - before.base) / MINUTE)).toEqual([60]);
  });

  it.each(["disable the agent", "suspend its owner"] as const)(
    "disable a row whose agent actor can no longer act: %s",
    async (end) => {
      const f = await scheduleRepo({ "b.txt": "b\n" });
      const writer = await user();
      expect(
        (
          await api("PUT", `${f.path}/collaborators/${writer.handle}`, f.owner.token, {
            permission: "push",
          })
        ).status,
      ).toBe(200);
      const agent = await agentFor(writer, ["contents:write"]);
      const account = await recordedAccount(env, {
        id: f.owner.principalId,
        handle: f.owner.handle,
      });
      const granted = await account.setCollaborator(
        { principalId: f.owner.principalId },
        f.repo.id,
        { id: agent.id, handle: agent.handle },
        "write",
      );
      if (!granted.ok) throw new Error(granted.error);
      await f.stub.invalidateAcl(f.owner.principalId, granted.epochGen, granted.version);
      const asAgent = { principalId: agent.id, token: agent.own, handle: agent.handle };
      await commitLive(f, "main", { [CI]: scheduled(["*/5 * * * *"]) }, "add", asAgent);
      await runTriggers(f.stub);
      expect(await rowsOf(f)).toMatchObject([{ actor_id: agent.id, disabled: null }]);
      if (end === "disable the agent")
        expect((await api("DELETE", `/agents/${agent.handle}`, writer.token)).status).toBeLessThan(
          300,
        );
      else {
        const admin = await user(true);
        expect(
          (await api("PUT", `/users/${writer.handle}/suspended`, admin.token, {})).status,
        ).toBe(204);
      }
      await fireAt(f, f.base + 10_000);
      expect(await scheduleRuns(f)).toEqual([]);
      expect(await rowsOf(f)).toMatchObject([{ disabled: "actor_lost" }]);
    },
  );

  it("refresh from the default branch's move in a push whose branches were refused", async () => {
    const f = await scheduleRepo({ "b.txt": "b\n" });
    const start = await commitLive(f, "main", { "c.txt": "c\n" });
    expect(await pushLive(f, [{ old: ZERO, new: start, ref: "refs/heads/side" }])).toContain(
      "ok refs/heads/side",
    );
    const next = await commitLive(f, "side", { [CI]: scheduled(["*/5 * * * *"]) });
    await runTriggers(f.stub);
    // Not atomic: each ref commits on its own, the default branch last, after 21 branches.
    const branches = Array.from({ length: 21 }, (_, i) => ({
      old: ZERO,
      new: start,
      ref: `refs/heads/b${i}`,
    }));
    expect(
      await pushLive(f, [...branches, { old: start, new: next, ref: "refs/heads/main" }]),
    ).toContain("ok refs/heads/main");
    await runTriggers(f.stub);
    const events = await eventsOf(f.stub, { refreshes: true });
    expect(events.filter((e) => e.outcome === "too_many_refs")).toHaveLength(1);
    expect(
      events.filter((e) => e.kind === "schedule_refresh").map((e) => JSON.parse(e.facts)),
    ).toContainEqual({ source: "push", sha: next });
    expect(await rowsOf(f)).toMatchObject([{ workflow_path: CI, cron: "*/5 * * * *" }]);
  });

  it.each([
    ["past the dates a Date holds", "9007199254740991"],
    ["later than now", "far"],
  ])("apply no cutoff %s, saying so, and go on scheduling", async (_, value) => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const cutoff = value === "far" ? new Date(f.base + 6 * 366 * DAY).toISOString() : value;
    await setVar(f.stub, "FYRDEN_CI_SINCE", cutoff);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await fireAt(f, f.base + 30_000);
      expect((await scheduleRuns(f)).map((r) => r.tick)).toEqual([f.base]);
      expect(await rowsOf(f)).toMatchObject([{ disabled: null, next_at: f.base + 5 * MINUTE }]);
      const said = warn.mock.calls.flatMap(([line]) => {
        try {
          return [JSON.parse(String(line)) as { msg?: string }];
        } catch {
          return [];
        }
      });
      expect(said.some((l) => l.msg?.startsWith("FYRDEN_CI_SINCE"))).toBe(true);
    } finally {
      warn.mockRestore();
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });

  it.each([
    ["at the clock", 0],
    ["1 ms ahead of the clock", 1],
    ["4 minutes ahead of the clock", 4 * MINUTE],
  ])("apply a cutoff %s: no tick before it fires, the one after it does", async (_, lead) => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const now = f.base + 30_000;
    await setVar(f.stub, "FYRDEN_CI_SINCE", String(now + lead));
    try {
      await fireAt(f, now);
      expect(await scheduleRuns(f)).toEqual([]);
      expect(await rowsOf(f)).toMatchObject([{ disabled: null, next_at: f.base + 5 * MINUTE }]);
      await fireAt(f, f.base + 5 * MINUTE + 10_000);
      expect((await scheduleRuns(f)).map((r) => (r.tick - f.base) / MINUTE)).toEqual([5]);
    } finally {
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });

  it("ignore a cutoff more than 5 minutes ahead of the clock, saying so", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const now = f.base + 30_000;
    await setVar(f.stub, "FYRDEN_CI_SINCE", String(now + 6 * MINUTE));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await fireAt(f, now);
      expect((await scheduleRuns(f)).map((r) => r.tick)).toEqual([f.base]);
      expect(warned(warn, "FYRDEN_CI_SINCE is more than 5 minutes ahead")).toBe(true);
    } finally {
      warn.mockRestore();
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });

  it("keep retrying, enabled, an entry a cutoff left with no occurrence in reach, until one is", async () => {
    // Every February 29th: none from 2097 for more than five years (2100 has none).
    const f = await scheduleRepo({ [CI]: scheduled(["0 0 29 2 *"]) });
    const cutoff = Date.UTC(2097, 0, 1);
    const sql = (query: string, ...args: SqlStorageValue[]) =>
      inRepo(f.stub, (r: RepoDO) => {
        r.git.context.storage.sql.exec(query, ...args);
      });
    await sql("UPDATE ci_schedules SET next_at = ?", Date.UTC(2096, 1, 29));
    await setVar(f.stub, "FYRDEN_CI_SINCE", String(cutoff));
    // The schedule job alone, at `at`, the repository pushed to the day before (not inactive).
    const alarm = async (at: number) => {
      await sql("UPDATE repo_meta SET pushed_at = ? WHERE id = 1", at - DAY);
      f.clock.now = at;
      await inRepo(f.stub, (r: RepoDO) =>
        r.git.jobs.runJob(CI_SCHEDULE_JOB, r.ciSchedules.handler(), r.git.memory, at + 60_000),
      );
      return (await rowsOf(f))[0];
    };
    const ticks = async () =>
      (await eventsOf(f.stub))
        .filter((e) => e.kind === "schedule")
        .map((e) => JSON.parse(e.facts).tick);
    try {
      let at = cutoff;
      let last = 0;
      for (let i = 0; i < 3; i++) {
        const row = await alarm(at);
        expect(row).toMatchObject({ disabled: null });
        expect(row?.next_at).toBeGreaterThan(Math.max(at, last));
        expect(row?.next_at).toBeLessThanOrEqual(at + DAY);
        last = row?.next_at ?? 0;
        at = last;
      }
      expect(await ticks()).toEqual([]);
      // Once 2104-02-29 is within reach, the entry takes it, and fires there.
      const row = await alarm(Date.UTC(2099, 3, 1));
      expect(row).toMatchObject({ disabled: null, next_at: Date.UTC(2104, 1, 29) });
      await alarm(Date.UTC(2104, 1, 29) + 30_000);
      expect(await ticks()).toEqual([Date.UTC(2104, 1, 29)]);
    } finally {
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });

  it("find the latest occurrence across gaps longer than any one occurrence search", () => {
    // Every February 29th: none in 2100, so 2096 and 2104 are eight years apart.
    expect(
      latestOccurrence("0 0 29 2 *", Date.UTC(2092, 1, 29), Date.UTC(2104, 1, 29) + 30_000),
    ).toBe(Date.UTC(2104, 1, 29));
    expect(latestOccurrence("0 0 29 2 *", Date.UTC(2096, 1, 29), Date.UTC(2104, 1, 28))).toBe(
      Date.UTC(2096, 1, 29),
    );
  });
});

/** Whether a structured warning starting with `message` was logged. */
function warned(warn: { mock: { calls: unknown[][] } }, message: string): boolean {
  return warn.mock.calls.some(([line]) => {
    try {
      return String((JSON.parse(String(line)) as { msg?: unknown }).msg).startsWith(message);
    } catch {
      return false;
    }
  });
}

describe("schedule refreshes whose evaluation failed", () => {
  /** A user `f`'s owner made a collaborator with `permission`. */
  async function collaborator(f: CiRepo, permission: "push" | "admin" = "push") {
    const who = await user();
    expect(
      (await api("PUT", `${f.path}/collaborators/${who.handle}`, f.owner.token, { permission }))
        .status,
    ).toBe(200);
    return who;
  }

  /** Closes the newest pending schedule refresh as `outcome`, as giving its evaluation up does. */
  const failRefresh = (f: CiRepo, outcome: string | null = "evaluation_failed", facts?: object) =>
    inRepo(f.stub, (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const { id } = sql
        .exec<{ id: number }>(
          "SELECT max(id) AS id FROM ci_events WHERE kind = 'schedule_refresh' AND state = 'pending'",
        )
        .one();
      sql.exec(
        `UPDATE ci_events SET state = 'done', outcome = ?, done_at = ?,
           facts = coalesce(?, facts) WHERE id = ?`,
        outcome,
        r.git.context.now(),
        facts ? JSON.stringify(facts) : null,
        id,
      );
      return id;
    });

  const watermark = (f: CiRepo) =>
    inRepo(
      f.stub,
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ refreshed_event: number }>(
            "SELECT coalesce(max(refreshed_event), 0) AS refreshed_event FROM ci_schedule_state",
          )
          .one().refreshed_event,
    );

  /** Runs the trigger job once (one slice and what follows in its invocation), counting what it does. */
  const counted = (f: CiRepo) =>
    inRepo(f.stub, async (r: RepoDO) => {
      const metrics = r.git.context.metrics as { count: (...args: unknown[]) => void };
      const original = { count: metrics.count, apply: r.ciSchedules.apply };
      const seen = { applied: [] as number[], dropped: 0 };
      metrics.count = (...args: unknown[]) => {
        if (args[0] === "ci.schedule_refresh_dropped") seen.dropped += (args[2] as number) ?? 1;
        return original.count.apply(metrics, args);
      };
      r.ciSchedules.apply = (eventId, ...rest) => {
        seen.applied.push(eventId);
        return original.apply.call(r.ciSchedules, eventId, ...rest);
      };
      try {
        const ran = await r.git.jobs.runJob(
          CI_TRIGGERS_JOB,
          r.ciTriggers.handler(),
          r.git.memory,
          r.git.context.now() + 60_000,
        );
        return { ...seen, state: ran.state };
      } finally {
        metrics.count = original.count;
        r.ciSchedules.apply = original.apply;
      }
    });

  it("keep the pusher of a failed refresh as the actor of the file they changed", async () => {
    for (const outcome of ["evaluation_failed", "retries_exhausted"]) {
      const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
      const writer = await collaborator(f);
      await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# y\n` }, "w", writer);
      await failRefresh(f, outcome);
      await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
      await runTriggers(f.stub);
      expect(await rowsOf(f), outcome).toMatchObject([{ actor_id: writer.principalId }]);
    }
  });

  it("give a file a failed refresh changed, and a later push changed again, to the later pusher", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const writer = await collaborator(f);
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# y\n` }, "w", writer);
    await failRefresh(f);
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# z\n` }, "again");
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: f.owner.principalId }]);
  });

  it("apply failed refreshes oldest first, each once, and none a newer refresh already passed", async () => {
    const second = ".github/workflows/weekly.yml";
    const f = await scheduleRepo({
      [CI]: scheduled(["*/5 * * * *"]),
      [second]: scheduled(["0 * * * *"], "weekly"),
    });
    const [one, two] = [await collaborator(f), await collaborator(f)];
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# 1\n` }, "1", one);
    const first = await failRefresh(f);
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# 2\n` }, "2", two);
    const failed = await failRefresh(f);
    await commitLive(
      f,
      "main",
      { [second]: `${scheduled(["0 * * * *"], "weekly")}# 1\n` },
      "3",
      one,
    );
    const last = await failRefresh(f);
    // A refresh newer than the first was applied already: the first is not applied after it.
    await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        "UPDATE ci_schedule_state SET refreshed_event = ? WHERE id = 1",
        first,
      ),
    );
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    const ran = await counted(f);
    expect(ran.applied.slice(0, 2)).toEqual([failed, last]);
    expect(ran.applied).toHaveLength(3);
    expect(await rowsOf(f)).toMatchObject([
      { workflow_path: CI, actor_id: two.principalId },
      { workflow_path: second, actor_id: one.principalId },
    ]);
    // Applied once: the next refresh applies only itself.
    await commitLive(f, "main", { "c.txt": "c\n" }, "unrelated again");
    expect((await counted(f)).applied).toHaveLength(1);
  });

  it("apply a failed change of the default branch as one: every row the changer's", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const admin = await collaborator(f, "admin");
    const main = (await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token)))
      .body.sha;
    await pushLive(f, [{ old: ZERO, new: main, ref: "refs/heads/release" }]);
    await runTriggers(f.stub);
    expect(
      (await live(f, () => api("PATCH", f.path, admin.token, { default_branch: "release" })))
        .status,
    ).toBe(200);
    await failRefresh(f);
    await commitLive(f, "release", { "b.txt": "b\n" }, "unrelated");
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: admin.principalId }]);
  });

  it("drop a failed refresh whose commit cannot be read, once, and refresh from the next one", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const writer = await collaborator(f);
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# y\n` }, "w", writer);
    // Its commit is gone (a force-push and a collection since).
    const gone = await failRefresh(f, "evaluation_failed", { source: "push", sha: "1".repeat(40) });
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    const ran = await counted(f);
    expect(ran.dropped).toBe(1);
    expect(ran.applied).toHaveLength(1);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: f.owner.principalId }]);
    expect(await watermark(f)).toBeGreaterThan(gone);
    expect(
      logs.entries().find((e) => e.msg === "a failed schedule refresh could not be read: dropped"),
    ).toMatchObject({ event: gone });
    await commitLive(f, "main", { "c.txt": "c\n" }, "unrelated again");
    expect((await counted(f)).dropped).toBe(0);
  });

  it("retry the newer refresh, dropping nothing, when a read fails temporarily", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const writer = await collaborator(f);
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# y\n` }, "w", writer);
    await failRefresh(f);
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeRead: () => {
          throw new Error("the object store could not be reached");
        },
      };
    });
    const ran = await counted(f);
    expect(ran.dropped).toBe(0);
    expect((await eventsOf(f.stub, { refreshes: true })).at(-1)).toMatchObject({
      kind: "schedule_refresh",
      state: "pending",
      attempts: 1,
    });
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {};
    });
    f.clock.now += 60 * MINUTE;
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: writer.principalId }]);
  });

  it("spend at most a slice's steps on failed refreshes, resuming after the last one done", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const writer = await collaborator(f);
    const total = ABSORB_STEPS + 2;
    for (let i = 0; i < total; i++) {
      await commitLive(f, "main", { [`f${i}.txt`]: "x\n" }, `${i}`, writer);
      await failRefresh(f, "evaluation_failed", { source: "push", sha: "1".repeat(40) });
    }
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# y\n` }, "w", writer);
    await failRefresh(f);
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    const first = await counted(f);
    expect(first).toMatchObject({ dropped: ABSORB_STEPS, applied: [], state: "queued" });
    const second = await counted(f);
    expect(second.dropped).toBe(total - ABSORB_STEPS);
    expect(second.applied).toHaveLength(2);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: writer.principalId }]);
  });

  it("read the inbox between the last refresh and this one in pages, a slice's steps at a time", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const from = await watermark(f);
    // Decided events since the last refresh, none of them a failed refresh.
    const backlog = ABSORB_STEPS * ABSORB_PAGE + 10;
    await inRepo(f.stub, (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (let i = 0; i < backlog; i++)
        sql.exec(
          `INSERT INTO ci_events (key, kind, state, outcome, facts, created_at, done_at)
           VALUES (?, 'push', 'done', 'not_a_commit', '{}', 1, ?)`,
          `backlog:${i}`,
          r.git.context.now(),
        );
    });
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    const first = await counted(f);
    expect(first).toMatchObject({ applied: [], state: "queued" });
    expect(await watermark(f)).toBe(from + ABSORB_STEPS * ABSORB_PAGE);
    expect((await counted(f)).applied).toHaveLength(1);
  });

  it("move the watermark on a refresh that schedules nothing", async () => {
    const f = await scheduleRepo({ "b.txt": "b\n" });
    await commitLive(f, "main", { "c.txt": "c\n" }, "unrelated");
    await runTriggers(f.stub);
    const [last] = (await eventsOf(f.stub, { refreshes: true }))
      .filter((e) => e.kind === "schedule_refresh")
      .slice(-1);
    expect(await watermark(f)).toBe(last?.id);
  });

  it("keep a failed refresh past the retention until it is applied, then prune it", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const writer = await collaborator(f);
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# y\n` }, "w", writer);
    const failed = await failRefresh(f);
    const exists = () =>
      inRepo(
        f.stub,
        (r: RepoDO) =>
          r.git.context.storage.sql.exec("SELECT 1 FROM ci_events WHERE id = ?", failed).toArray()
            .length > 0,
      );
    f.clock.now += 8 * DAY;
    await runTriggers(f.stub);
    expect(await exists()).toBe(true);
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    await runTriggers(f.stub);
    expect(await rowsOf(f)).toMatchObject([{ actor_id: writer.principalId }]);
    // The next slice (a slice prunes as it starts) deletes it, applied.
    await commitLive(f, "main", { "c.txt": "c\n" }, "unrelated again");
    await runTriggers(f.stub);
    expect(await exists()).toBe(false);
  });

  it("prune a decided refresh that did not fail at the retention, whatever the watermark", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
    // Decided without an outcome, and passed by no later refresh.
    const decided = await failRefresh(f, null);
    expect(await watermark(f)).toBeLessThan(decided);
    f.clock.now += 8 * DAY;
    // A push to another branch: a slice (which prunes as it starts), and no refresh.
    const main = (await json<{ sha: string }>(api("GET", `${f.path}/commits/main`, f.owner.token)))
      .body.sha;
    await pushLive(f, [{ old: ZERO, new: main, ref: "refs/heads/feature" }]);
    await runTriggers(f.stub);
    expect((await eventsOf(f.stub, { refreshes: true })).map((e) => e.id)).not.toContain(decided);
  });

  it("apply a failed refresh from before the CI cutoff: it starts no run", async () => {
    const f = await scheduleRepo({ [CI]: scheduled(["*/5 * * * *"]) });
    const writer = await collaborator(f);
    await commitLive(f, "main", { [CI]: `${scheduled(["*/5 * * * *"])}# y\n` }, "w", writer);
    const failed = await failRefresh(f);
    const recorded = (await eventsOf(f.stub, { refreshes: true })).find((e) => e.id === failed);
    // The cutoff falls after the failed refresh was recorded, and before the next one.
    const since = (recorded?.created_at as number) + 1;
    await setVar(f.stub, "FYRDEN_CI_SINCE", String(since));
    try {
      await commitLive(f, "main", { "b.txt": "b\n" }, "unrelated");
      const next = (await eventsOf(f.stub, { refreshes: true })).at(-1);
      expect(next?.created_at as number).toBeGreaterThanOrEqual(since);
      const before = (await eventRunsOf(f.stub)).length;
      await runTriggers(f.stub);
      expect(await rowsOf(f)).toMatchObject([{ actor_id: writer.principalId }]);
      expect(await eventRunsOf(f.stub)).toHaveLength(before);
    } finally {
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });
});
